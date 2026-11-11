import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PlatformStaffStatus, Prisma, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformMfaService } from '../../src/modules/platform/auth/platform-mfa.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { PlatformTotpService } from '../../src/modules/platform/auth/platform-totp.service.js';

describe('PlatformMfaService', () => {
	const challengeFindUnique = jest.fn<() => Promise<unknown>>();
	const challengeUpdateMany = jest.fn<() => Promise<{ count: number }>>();
	const totpUpdateMany = jest.fn<() => Promise<{ count: number }>>();
	const recoveryUpdateMany = jest.fn<() => Promise<{ count: number }>>();
	const sessionCreate = jest.fn<(input: unknown) => Promise<unknown>>();
	const auditCreate = jest.fn<(input: unknown) => Promise<unknown>>();
	const transaction = {
		platformMfaChallenge: {
			findUnique: challengeFindUnique,
			updateMany: challengeUpdateMany,
		},
		platformTotpCredential: { updateMany: totpUpdateMany },
		platformRecoveryCode: { updateMany: recoveryUpdateMany },
		platformAdminSession: { create: sessionCreate },
		identitySecurityAuditEvent: { create: auditCreate },
	};
	type TransactionOperation = (client: typeof transaction) => Promise<unknown>;
	const runTransaction = jest
		.fn<(operation: TransactionOperation, options?: unknown) => Promise<unknown>>()
		.mockImplementation((operation) => operation(transaction));
	const verifyTotp = jest.fn<() => { readonly timeStep: bigint } | null>();
	let service: PlatformMfaService;

	beforeAll(async () => {
		const config = new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({
				NODE_ENV: 'test',
				PLATFORM_AUTH_EMAIL_OTP_ENABLED: 'true',
				RESEND_API_KEY: 're_fictional',
				RESEND_FROM_EMAIL: 'security@example.com',
			}),
		);
		const module = await Test.createTestingModule({
			providers: [
				PlatformMfaService,
				{ provide: ConfigService, useValue: config },
				{
					provide: PrismaService,
					useValue: {
						$transaction: runTransaction,
						platformMfaChallenge: { updateMany: challengeUpdateMany },
					},
				},
				{
					provide: PlatformTokenService,
					useValue: {
						createToken: jest.fn<() => string>().mockReturnValue('session-token'),
						emailOtpDigest: jest
							.fn<(id: string, email: string, code: string) => string>()
							.mockImplementation((id, email, code) =>
								id === 'challenge-id' && email === 'admin@example.com' && code === '012345'
									? 'email-otp-digest'
									: 'wrong-digest',
							),
						equal: jest
							.fn<(left: string, right: string) => boolean>()
							.mockImplementation((left, right) => left === right),
						digest: jest
							.fn<(value: string) => string>()
							.mockImplementation((value) => `${value}-digest`),
					},
				},
				{ provide: PlatformTotpService, useValue: { verify: verifyTotp } },
			],
		}).compile();
		service = module.get(PlatformMfaService);
	});

	beforeEach(() => {
		jest.clearAllMocks();
		challengeFindUnique.mockResolvedValue(createChallenge());
		challengeUpdateMany.mockResolvedValue({ count: 1 });
		totpUpdateMany.mockResolvedValue({ count: 1 });
		recoveryUpdateMany.mockResolvedValue({ count: 1 });
		sessionCreate.mockResolvedValue({ id: 'session-id' });
		auditCreate.mockResolvedValue({ id: 'audit-id' });
		verifyTotp.mockReturnValue({ timeStep: 31_556_952n });
	});

	it('rejects an MFA proof started before a password change even if inserted later', async () => {
		const challenge = createChallenge();
		challenge.platformStaff.user.passwordCredential.passwordChangedAt = new Date(
			'2030-01-01T00:00:01.000Z',
		);
		challengeFindUnique.mockResolvedValue(challenge);
		await expect(
			service.verify(
				{
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'totp',
					totpCode: '123456',
				},
				new Date('2030-01-01T00:00:02.000Z'),
			),
		).rejects.toMatchObject({ status: 401 });
		expect(verifyTotp).not.toHaveBeenCalled();
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it('atomically accepts one TOTP step, consumes the challenge, and creates a session', async () => {
		await expect(
			service.verify(
				{
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'totp',
					totpCode: '123456',
				},
				new Date('2030-01-01T00:00:00.000Z'),
			),
		).resolves.toMatchObject({ status: 'authenticated', sessionToken: 'session-token' });
		expect(totpUpdateMany).toHaveBeenCalledTimes(1);
		expect(challengeUpdateMany).toHaveBeenCalledTimes(1);
		expect(sessionCreate).toHaveBeenCalledTimes(1);
		expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 8_000,
			timeout: 10_000,
		});
		expect(challengeFindUnique).toHaveBeenCalledTimes(1);
	});

	it.each(['P2028', 'P2034', 'P2039'])(
		'returns a safe unavailable error for transaction failure %s without retrying',
		async (code) => {
			runTransaction.mockRejectedValueOnce({ code });

			await expect(
				service.verify({
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'totp',
					totpCode: '123456',
				}),
			).rejects.toMatchObject({
				status: 503,
				response: {
					code: 'PLATFORM_MFA_UNAVAILABLE',
					message: 'MFA verification is temporarily unavailable. Start sign-in again.',
				},
			});
			expect(runTransaction).toHaveBeenCalledTimes(1);
			expect(sessionCreate).not.toHaveBeenCalled();
		},
	);

	it('returns the same safe unavailable error when the atomic challenge read cannot connect', async () => {
		challengeFindUnique.mockRejectedValueOnce({ code: 'P1001' });

		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'totp',
				totpCode: '123456',
			}),
		).rejects.toMatchObject({
			status: 503,
			response: { code: 'PLATFORM_MFA_UNAVAILABLE' },
		});
		expect(runTransaction).toHaveBeenCalledTimes(1);
	});

	it('requires successful MFA even when a system owner has no per-permission grants', async () => {
		const owner = createChallenge();
		owner.platformStaff.roles = [
			{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } },
		];
		challengeFindUnique.mockResolvedValue(owner);
		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'totp',
				totpCode: '123456',
			}),
		).resolves.toMatchObject({ status: 'authenticated' });
		expect(totpUpdateMany).toHaveBeenCalledTimes(1);
		expect(sessionCreate).toHaveBeenCalledTimes(1);
	});

	it('rejects a reused TOTP step and records a bounded failed attempt', async () => {
		totpUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'totp',
				totpCode: '123456',
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(challengeUpdateMany).toHaveBeenCalledWith({
			where: { id: 'challenge-id', consumedAt: null, failedAttempts: { lt: 5 } },
			data: { failedAttempts: { increment: 1 } },
		});
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it('atomically consumes a single-use recovery code', async () => {
		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'recovery_code',
				recoveryCode: 'FICTIONAL-RECOVERY-CODE',
			}),
		).resolves.toMatchObject({ status: 'authenticated' });
		expect(recoveryUpdateMany).toHaveBeenCalledTimes(1);
		expect(sessionCreate).toHaveBeenCalledTimes(1);
	});

	it('atomically clears an email OTP and consumes its challenge before issuing a session', async () => {
		await expect(
			service.verify(
				{
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'email_otp',
					emailOtpCode: '012345',
				},
				new Date('2030-01-01T00:00:00.000Z'),
			),
		).resolves.toMatchObject({ status: 'authenticated' });
		expect(challengeUpdateMany).toHaveBeenCalledTimes(2);
		expect(challengeUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'challenge-id',
				consumedAt: null,
				emailOtpDigest: 'email-otp-digest',
				emailOtpExpiresAt: { gt: new Date('2030-01-01T00:00:00.000Z') },
			},
			data: { emailOtpDigest: null, emailOtpExpiresAt: null },
		});
		expect(totpUpdateMany).not.toHaveBeenCalled();
		expect(recoveryUpdateMany).not.toHaveBeenCalled();
		expect(sessionCreate).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ emailOtpDigest: null },
		{ emailOtpExpiresAt: new Date('2029-12-31T23:59:00.000Z') },
		{ emailOtpDigest: 'superseded-digest' },
	])('rejects unavailable, expired or superseded email OTPs: %p', async (state) => {
		challengeFindUnique.mockResolvedValue({ ...createChallenge(), ...state });
		await expect(
			service.verify(
				{
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'email_otp',
					emailOtpCode: '012345',
				},
				new Date('2030-01-01T00:00:00.000Z'),
			),
		).rejects.toMatchObject({ status: 401 });
		expect(sessionCreate).not.toHaveBeenCalled();
		expect(challengeUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { failedAttempts: { increment: 1 } } }),
		);
	});

	it('rejects email verification when another transaction already consumed the code', async () => {
		challengeUpdateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'email_otp',
				emailOtpCode: '012345',
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it('rejects mixed MFA factors before reading the challenge', async () => {
		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'email_otp',
				emailOtpCode: '012345',
				totpCode: '123456',
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(runTransaction).not.toHaveBeenCalled();
	});

	it('does not create two sessions when the challenge loses a concurrent consume race', async () => {
		challengeUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'totp',
				totpCode: '123456',
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it.each([
		{ consumedAt: new Date('2030-01-01T00:00:00.000Z') },
		{ expiresAt: new Date('2030-01-01T00:00:00.000Z') },
		{ failedAttempts: 5 },
	])('rejects a terminal pending state before checking a factor: %p', async (state) => {
		challengeFindUnique.mockResolvedValue({ ...createChallenge(), ...state });
		await expect(
			service.verify(
				{
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'totp',
					totpCode: '123456',
				},
				new Date('2030-01-01T00:00:00.000Z'),
			),
		).rejects.toMatchObject({ status: 401, terminal: true });
		expect(verifyTotp).not.toHaveBeenCalled();
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it('withholds a session when transactional audit persistence fails', async () => {
		auditCreate.mockRejectedValueOnce(new Error('synthetic audit failure'));
		await expect(
			service.verify({
				challengeToken: 'challenge-token-with-more-than-32-characters',
				method: 'totp',
				totpCode: '123456',
			}),
		).rejects.toMatchObject({ status: 503, response: { code: 'PLATFORM_MFA_UNAVAILABLE' } });
	});

	it.each([{ status: PlatformStaffStatus.SUSPENDED }, { roles: [] }])(
		'rechecks suspended staff and revoked grants before MFA issuance: %p',
		async (state) => {
			const challenge = createChallenge();
			challengeFindUnique.mockResolvedValue({
				...challenge,
				platformStaff: { ...challenge.platformStaff, ...state },
			});
			await expect(
				service.verify({
					challengeToken: 'challenge-token-with-more-than-32-characters',
					method: 'totp',
					totpCode: '123456',
				}),
			).rejects.toMatchObject({ status: 401, terminal: true });
			expect(sessionCreate).not.toHaveBeenCalled();
		},
	);

	it('audits session issuance without storing the raw token', async () => {
		await service.verify({
			challengeToken: 'challenge-token-with-more-than-32-characters',
			method: 'totp',
			totpCode: '123456',
		});
		expect(sessionCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { tokenDigest: 'session-token-digest' },
		});
		expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { userId: 'user-id', actorKind: 'authentication', action: 'platform_session_issued' },
		});
		expect(JSON.stringify(sessionCreate.mock.calls)).not.toContain('"session-token"');
		expect(JSON.stringify(auditCreate.mock.calls)).not.toContain('123456');
	});

	it('revokes and audits only an unused pending challenge', async () => {
		await service.revokeChallenge('challenge-token-with-more-than-32-characters');
		expect(challengeUpdateMany).toHaveBeenCalledTimes(1);
		expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { action: 'platform_challenge_revoked', actorUserId: 'user-id' },
		});
		challengeFindUnique.mockResolvedValue({ ...createChallenge(), consumedAt: new Date() });
		await service.revokeChallenge('challenge-token-with-more-than-32-characters');
		expect(auditCreate).toHaveBeenCalledTimes(1);
	});
});

function createChallenge() {
	return {
		id: 'challenge-id',
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
		platformStaffId: 'staff-id',
		expiresAt: new Date('2030-01-01T00:05:00.000Z'),
		consumedAt: null,
		failedAttempts: 0,
		maxAttempts: 5,
		emailOtpDigest: 'email-otp-digest',
		emailOtpExpiresAt: new Date('2030-01-01T00:05:00.000Z'),
		platformStaff: {
			status: PlatformStaffStatus.ACTIVE,
			user: {
				id: 'user-id',
				identityVersion: 1,
				email: 'admin@example.com',
				passwordCredential: {
					passwordChangedAt: new Date('2029-01-01T00:00:00.000Z'),
					disabledAt: null,
				},
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date('2029-01-01T00:00:00.000Z'),
			},
			roles: [
				{
					platformRole: {
						key: 'platform.operator',
						isSystem: false,
						permissions: [{ platformPermission: { key: 'platform.dashboard.read' } }],
					},
				},
			],
			totpCredential: {
				id: 'totp-id',
				platformStaffId: 'staff-id',
				encryptedSecret: Buffer.from('encrypted'),
				encryptionKeyId: 'local-v1',
				encryptionVersion: 1,
				initializationVector: Buffer.alloc(12),
				authenticationTag: Buffer.alloc(16),
				createdAt: new Date('2029-01-01T00:00:00.000Z'),
				verifiedAt: new Date('2029-01-01T00:00:00.000Z'),
				lastUsedAt: null,
				lastAcceptedTimeStep: null,
				disabledAt: null,
			},
		},
	};
}
