import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PlatformStaffStatus, Prisma, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformLoginAttemptService } from '../../src/modules/platform/auth/platform-login-attempt.service.js';
import { PlatformLoginService } from '../../src/modules/platform/auth/platform-login.service.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';

describe('PlatformLoginService', () => {
	const userFindUnique = jest.fn<() => Promise<unknown>>();
	const challengeUpdateMany = jest.fn<() => Promise<{ count: number }>>();
	const challengeCreate = jest.fn<(args: { data: { createdAt: Date } }) => Promise<unknown>>();
	const auditCreate = jest.fn<(input: unknown) => Promise<unknown>>();
	const transaction = {
		user: { findUnique: userFindUnique },
		platformMfaChallenge: { updateMany: challengeUpdateMany, create: challengeCreate },
		identitySecurityAuditEvent: { create: auditCreate },
	};
	const runTransaction = jest
		.fn<
			(operation: (client: typeof transaction) => Promise<void>, options?: unknown) => Promise<void>
		>()
		.mockImplementation((operation) => operation(transaction));
	const verifyPassword = jest.fn<() => Promise<boolean>>();
	const consume = jest.fn<() => void>();
	const createToken = jest.fn<() => string>();
	let service: PlatformLoginService;

	beforeAll(async () => {
		const config = new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({ NODE_ENV: 'test' }),
		);
		const module = await Test.createTestingModule({
			providers: [
				PlatformLoginService,
				{ provide: ConfigService, useValue: config },
				{
					provide: PrismaService,
					useValue: {
						user: { findUnique: userFindUnique },
						platformMfaChallenge: {
							updateMany: challengeUpdateMany,
							create: challengeCreate,
						},
						$transaction: runTransaction,
					},
				},
				{
					provide: PlatformPasswordService,
					useValue: { dummyHash: 'dummy-hash', verify: verifyPassword },
				},
				{
					provide: PlatformTokenService,
					useValue: {
						createToken,
						digest: jest.fn<(value: string) => string>().mockReturnValue('challenge-digest'),
					},
				},
				{
					provide: PlatformLoginAttemptService,
					useValue: { consume },
				},
			],
		}).compile();
		service = module.get(PlatformLoginService);
	});

	beforeEach(() => {
		jest.clearAllMocks();
		createToken.mockReset().mockReturnValueOnce('challenge-token').mockReturnValue('csrf-token');
		challengeUpdateMany.mockResolvedValue({ count: 0 });
		challengeCreate.mockResolvedValue({ id: 'challenge-id' });
		auditCreate.mockResolvedValue({ id: 'audit-id' });
	});

	it('creates only an MFA challenge for an eligible identity', async () => {
		userFindUnique.mockResolvedValue({
			id: 'user-id',
			identityVersion: 1,
			status: UserStatus.ACTIVE,
			emailVerifiedAt: new Date('2030-01-01T00:00:00.000Z'),
			passwordCredential: { passwordHash: 'approved-hash', normalization: 'raw', disabledAt: null },
			platformStaff: {
				id: 'staff-id',
				status: PlatformStaffStatus.ACTIVE,
				roles: [{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } }],
				totpCredential: {
					verifiedAt: new Date('2030-01-01T00:00:00.000Z'),
					disabledAt: null,
				},
				recoveryCodes: [],
			},
		});
		verifyPassword.mockResolvedValue(true);

		await expect(
			service.login(
				{ email: 'admin@example.com', password: 'fictional password' },
				'192.0.2.10',
				new Date('2030-01-01T00:00:00.000Z'),
			),
		).resolves.toMatchObject({ challengeToken: 'challenge-token', methods: ['totp'] });
		expect(challengeCreate).toHaveBeenCalledTimes(1);
		expect(challengeCreate.mock.calls[0]?.[0].data.createdAt).toEqual(
			new Date('2030-01-01T00:00:00.000Z'),
		);
		expect(consume).toHaveBeenCalledTimes(1);
		expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 5000,
			timeout: 10_000,
		});
	});

	it('returns a safe unavailable error when the adapter omits a database code', async () => {
		userFindUnique.mockRejectedValueOnce(new Error('redacted adapter failure'));

		await expect(
			service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
		).rejects.toMatchObject({
			status: 503,
			response: { code: 'PLATFORM_LOGIN_UNAVAILABLE' },
		});
		expect(verifyPassword).not.toHaveBeenCalled();
	});

	it.each(['P2028', 'P2034', 'P2039'])(
		'returns a safe unavailable error for challenge transaction failure %s',
		async (code) => {
			userFindUnique.mockResolvedValue({
				id: 'user-id',
				identityVersion: 1,
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date('2030-01-01T00:00:00.000Z'),
				passwordCredential: {
					passwordHash: 'approved-hash',
					normalization: 'raw',
					disabledAt: null,
				},
				platformStaff: {
					id: 'staff-id',
					status: PlatformStaffStatus.ACTIVE,
					roles: [{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } }],
					totpCredential: {
						verifiedAt: new Date('2030-01-01T00:00:00.000Z'),
						disabledAt: null,
					},
					recoveryCodes: [],
				},
			});
			verifyPassword.mockResolvedValue(true);
			runTransaction.mockRejectedValueOnce({ code });

			await expect(
				service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
			).rejects.toMatchObject({
				status: 503,
				response: {
					code: 'PLATFORM_LOGIN_UNAVAILABLE',
					message: 'Sign-in is temporarily unavailable. Try again.',
				},
			});
			expect(runTransaction).toHaveBeenCalledTimes(1);
		},
	);

	it('returns the same safe unavailable error when the identity read cannot connect', async () => {
		userFindUnique.mockRejectedValueOnce({ code: 'P1001' });

		await expect(
			service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
		).rejects.toMatchObject({
			status: 503,
			response: { code: 'PLATFORM_LOGIN_UNAVAILABLE' },
		});
		expect(verifyPassword).not.toHaveBeenCalled();
		expect(runTransaction).not.toHaveBeenCalled();
	});

	it('uses the dummy hash and returns the generic failure for an unknown email', async () => {
		userFindUnique.mockResolvedValue(null);
		verifyPassword.mockResolvedValue(false);

		await expect(
			service.login({ email: 'missing@example.com', password: 'fictional password' }, '192.0.2.10'),
		).rejects.toMatchObject({ status: 401 });
		expect(verifyPassword).toHaveBeenCalledWith('dummy-hash', 'fictional password', 'raw');
		expect(consume).toHaveBeenCalledTimes(1);
		expect(challengeCreate).not.toHaveBeenCalled();
	});

	it('fails closed when the administrator has no confirmed MFA factor', async () => {
		userFindUnique.mockResolvedValue({
			id: 'user-id',
			identityVersion: 1,
			status: UserStatus.ACTIVE,
			emailVerifiedAt: new Date('2030-01-01T00:00:00.000Z'),
			passwordCredential: { passwordHash: 'approved-hash', normalization: 'raw', disabledAt: null },
			platformStaff: {
				id: 'staff-id',
				status: PlatformStaffStatus.ACTIVE,
				roles: [{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } }],
				totpCredential: null,
				recoveryCodes: [],
			},
		});
		verifyPassword.mockResolvedValue(true);

		await expect(
			service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
		).rejects.toMatchObject({ status: 401 });
		expect(challengeCreate).not.toHaveBeenCalled();
	});

	it.each([UserStatus.PENDING, UserStatus.SUSPENDED, UserStatus.DISABLED])(
		'rejects an ineligible global account with the generic credential error: %s',
		async (status) => {
			userFindUnique.mockResolvedValue({ ...eligibleIdentity(), status });
			verifyPassword.mockResolvedValue(true);
			await expect(
				service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
			).rejects.toMatchObject({
				status: 401,
				response: { code: 'PLATFORM_AUTHENTICATION_FAILED' },
			});
			expect(challengeCreate).not.toHaveBeenCalled();
		},
	);

	it.each([null, { ...eligibleIdentity().platformStaff, roles: [] }])(
		'rejects an organization-only identity or staff without platform grants: %p',
		async (platformStaff) => {
			userFindUnique.mockResolvedValue({ ...eligibleIdentity(), platformStaff });
			verifyPassword.mockResolvedValue(true);
			await expect(
				service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
			).rejects.toMatchObject({ status: 401 });
			expect(challengeCreate).not.toHaveBeenCalled();
		},
	);

	it('rejects changed credentials between password verification and challenge creation', async () => {
		userFindUnique
			.mockResolvedValueOnce(eligibleIdentity())
			.mockResolvedValueOnce({ ...eligibleIdentity(), identityVersion: 2 });
		verifyPassword.mockResolvedValue(true);
		await expect(
			service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
		).rejects.toMatchObject({ status: 401 });
		expect(challengeCreate).not.toHaveBeenCalled();
	});

	it.each([
		PlatformStaffStatus.PENDING,
		PlatformStaffStatus.SUSPENDED,
		PlatformStaffStatus.REVOKED,
	])(
		'rejects ineligible platform staff independently of the global account: %s',
		async (status) => {
			const identity = eligibleIdentity();
			userFindUnique.mockResolvedValue({
				...identity,
				platformStaff: { ...identity.platformStaff, status },
			});
			verifyPassword.mockResolvedValue(true);
			await expect(
				service.login({ email: 'admin@example.com', password: 'fictional password' }, '192.0.2.10'),
			).rejects.toMatchObject({ status: 401 });
			expect(challengeCreate).not.toHaveBeenCalled();
		},
	);
});

function eligibleIdentity() {
	return {
		id: 'user-id',
		identityVersion: 1,
		status: UserStatus.ACTIVE,
		emailVerifiedAt: new Date('2029-01-01T00:00:00.000Z'),
		passwordCredential: { passwordHash: 'approved-hash', normalization: 'raw', disabledAt: null },
		platformStaff: {
			id: 'staff-id',
			status: PlatformStaffStatus.ACTIVE,
			roles: [{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } }],
			totpCredential: { verifiedAt: new Date('2029-01-01T00:00:00.000Z'), disabledAt: null },
			recoveryCodes: [],
		},
	};
}
