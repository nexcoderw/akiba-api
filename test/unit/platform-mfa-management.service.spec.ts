import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PlatformStaffStatus, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { PlatformTotpService } from '../../src/modules/platform/auth/platform-totp.service.js';
import { PlatformMfaManagementService } from '../../src/modules/platform/mfa/platform-mfa-management.service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const FACTOR = '44444444-4444-4444-8444-444444444444';
const REQUEST = 'req_55555555-5555-4555-8555-555555555555';
const NOW = new Date('2030-01-01T00:01:00.000Z');
const TOKEN = Buffer.alloc(32, 1).toString('base64url');
const PROOF = Buffer.alloc(32, 2).toString('base64url');

function factor() {
	return {
		id: FACTOR,
		platformStaffId: STAFF,
		version: 1,
		label: 'Work',
		encryptedSecret: Buffer.alloc(32, 1),
		initializationVector: Buffer.alloc(12, 2),
		authenticationTag: Buffer.alloc(16, 3),
		encryptionKeyId: 'local-v1',
		encryptionVersion: 1,
		verifiedAt: new Date('2030-01-01T00:00:00.000Z'),
		disabledAt: null,
		lastAcceptedTimeStep: null,
		lastUsedAt: null,
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
	};
}

function session() {
	return {
		id: SESSION,
		platformStaffId: STAFF,
		authenticationMethod: 'totp',
		mfaVersion: 1,
		revokedAt: null,
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
		mfaVerifiedAt: new Date('2030-01-01T00:00:00.000Z'),
		expiresAt: new Date('2030-01-01T01:00:00.000Z'),
		idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
		platformStaff: {
			id: STAFF,
			status: PlatformStaffStatus.ACTIVE,
			mfaVersion: 1,
			recoveryGeneration: 1,
			totpCredential: factor(),
			roles: [{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } }],
			user: {
				id: USER,
				identityVersion: 1,
				email: 'owner@example.com',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date('2029-01-01T00:00:00.000Z'),
				passwordCredential: {
					version: 1,
					disabledAt: null,
					passwordHash: 'approved-hash',
					normalization: 'raw',
					passwordChangedAt: new Date('2029-01-01T00:00:00.000Z'),
				},
			},
		},
	};
}

function proof() {
	return {
		id: '66666666-6666-4666-8666-666666666666',
		purpose: 'step_up',
		operation: 'totp_replace',
		platformStaffId: STAFF,
		platformSessionId: SESSION,
		factorId: FACTOR,
		factorVersion: 1,
		identityVersion: 1,
		credentialVersion: 1,
		mfaVersion: 1,
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
		expiresAt: new Date('2030-01-01T00:05:00.000Z'),
		verifiedAt: new Date('2030-01-01T00:00:00.000Z'),
		consumedAt: null,
		failedAttempts: 0,
		maxAttempts: 5,
	};
}

describe('platform MFA management security boundary', () => {
	const findSession = jest.fn<() => Promise<unknown>>();
	const findProof = jest.fn<() => Promise<unknown>>();
	const findFactor = jest.fn<() => Promise<unknown>>();
	const createProof = jest.fn<(input: unknown) => Promise<unknown>>();
	const updateProof = jest.fn<(input: unknown) => Promise<{ count: number }>>();
	const updateFactor = jest.fn<(input: unknown) => Promise<{ count: number }>>();
	const renameFactor = jest.fn<(input: unknown) => Promise<unknown>>();
	const updateSession = jest.fn<(input: unknown) => Promise<{ count: number }>>();
	const updateCodes = jest.fn<(input: unknown) => Promise<{ count: number }>>();
	const createCodes = jest.fn<(input: unknown) => Promise<unknown>>();
	const audit = jest.fn<(input: unknown) => Promise<unknown>>();
	const notify = jest.fn<(input: unknown) => Promise<unknown>>();
	const password = jest.fn<() => Promise<boolean>>();
	const verifyTotp = jest.fn<() => { timeStep: bigint } | null>();
	const tx = {
		$queryRaw: jest.fn<() => Promise<unknown>>().mockResolvedValue([{ now: NOW }]),
		platformAdminSession: { findUnique: findSession, updateMany: updateSession },
		platformMfaChallenge: { findUnique: findProof, create: createProof, updateMany: updateProof },
		platformTotpCredential: {
			findUnique: findFactor,
			updateMany: updateFactor,
			update: renameFactor,
		},
		platformRecoveryCode: { updateMany: updateCodes, createMany: createCodes },
		identitySecurityAuditEvent: { create: audit },
		platformSecurityNotification: { create: notify },
		platformStaff: {
			findUniqueOrThrow: jest
				.fn<() => Promise<unknown>>()
				.mockResolvedValue({ id: STAFF, recoveryGeneration: 2 }),
			update: jest
				.fn<() => Promise<unknown>>()
				.mockResolvedValue({ id: STAFF, recoveryGeneration: 2 }),
		},
	};
	const transaction = jest
		.fn<(operation: (client: typeof tx) => Promise<unknown>) => Promise<unknown>>()
		.mockImplementation((operation) => operation(tx));
	let service: PlatformMfaManagementService;
	let tokens: PlatformTokenService;
	let module: TestingModule;

	beforeAll(async () => {
		const config = new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({
				NODE_ENV: 'test',
				PLATFORM_MFA_MANAGEMENT_ENABLED: 'true',
				RESEND_API_KEY: 're_fictional',
				RESEND_FROM_EMAIL: 'security@example.com',
			}),
		);
		tokens = new PlatformTokenService(config);
		module = await Test.createTestingModule({
			providers: [
				PlatformMfaManagementService,
				{ provide: ConfigService, useValue: config },
				{
					provide: PrismaService,
					useValue: {
						$transaction: transaction,
						platformTotpCredential: { findUnique: findFactor },
						user: {
							findUnique: jest
								.fn<() => Promise<unknown>>()
								.mockImplementation(() => Promise.resolve(session().platformStaff.user)),
						},
					},
				},
				{
					provide: PlatformSessionService,
					useValue: {
						authenticateForMfaManagement: jest
							.fn<() => Promise<unknown>>()
							.mockResolvedValue({ sessionId: SESSION, platformStaffId: STAFF, userId: USER }),
					},
				},
				{ provide: PlatformPasswordService, useValue: { verify: password, dummyHash: 'dummy' } },
				{ provide: PlatformTokenService, useValue: tokens },
				{
					provide: PlatformTotpService,
					useValue: {
						verify: verifyTotp,
						createEnrollment: jest.fn<() => unknown>().mockReturnValue({
							...factor(),
							secret: 'JBSWY3DPEHPK3PXP',
							enrollmentUri: 'otpauth://totp/Akiba:owner',
						}),
					},
				},
			],
		}).compile();
		service = module.get(PlatformMfaManagementService);
	});
	afterAll(async () => {
		await module.close();
	});
	beforeEach(() => {
		jest.clearAllMocks();
		findSession.mockResolvedValue(session());
		findProof.mockResolvedValue(proof());
		findFactor.mockResolvedValue(factor());
		createProof.mockResolvedValue({ id: 'proof-id' });
		updateProof.mockResolvedValue({ count: 1 });
		updateFactor.mockResolvedValue({ count: 1 });
		renameFactor.mockResolvedValue(factor());
		updateSession.mockResolvedValue({ count: 1 });
		updateCodes.mockResolvedValue({ count: 1 });
		createCodes.mockResolvedValue({ count: 10 });
		audit.mockResolvedValue({ id: 'audit-id' });
		notify.mockResolvedValue({ id: 'notification-id' });
		password.mockResolvedValue(true);
		verifyTotp.mockReturnValue({ timeStep: 100n });
	});

	it('lists only owned safe metadata, even when the adapter contains encrypted material', async () => {
		const result = await service.list(TOKEN);
		expect(result).toEqual([
			{
				id: FACTOR,
				type: 'totp',
				label: 'Work',
				status: 'active',
				createdAt: '2030-01-01T00:00:00.000Z',
				lastUsedAt: null,
			},
		]);
		expect(findFactor).toHaveBeenCalledWith({
			where: { platformStaffId: STAFF },
			select: {
				id: true,
				label: true,
				verifiedAt: true,
				disabledAt: true,
				createdAt: true,
				lastUsedAt: true,
			},
		});
	});

	it('requires the current password before creating any step-up proof', async () => {
		password.mockResolvedValue(false);
		await expect(
			service.start(
				TOKEN,
				{ operation: 'totp_replace', factorId: FACTOR, password: 'wrong' },
				REQUEST,
			),
		).rejects.toMatchObject({ publicCode: 'AUTH_REAUTHENTICATION_REQUIRED' });
		expect(createProof).not.toHaveBeenCalled();
	});

	it('does not mark an ordinary step-up verified at password success', async () => {
		await expect(
			service.start(
				TOKEN,
				{ operation: 'totp_replace', factorId: FACTOR, password: 'current' },
				REQUEST,
			),
		).resolves.toMatchObject({ verified: false });
		expect(createProof.mock.calls[0]?.[0]).toMatchObject({
			data: {
				purpose: 'step_up',
				operation: 'totp_replace',
				factorId: FACTOR,
				platformSessionId: SESSION,
				verifiedAt: null,
			},
		});
	});

	it.each([
		{ platformSessionId: 'other-session' },
		{ platformStaffId: 'other-staff' },
		{ operation: 'recovery_regenerate' },
		{ factorId: 'other-factor' },
		{ identityVersion: 2 },
		{ mfaVersion: 2 },
		{ credentialVersion: 2 },
		{ factorVersion: 2 },
		{ verifiedAt: null },
		{ consumedAt: NOW },
		{ expiresAt: NOW },
		{ failedAttempts: 5 },
	])(
		'rejects transferred, stale, unverified or replayed replacement authority: %p',
		async (state) => {
			findProof.mockResolvedValue({ ...proof(), ...state });
			await expect(
				service.enroll(TOKEN, PROOF, 'New factor', FACTOR, REQUEST),
			).rejects.toMatchObject({ publicCode: 'AUTH_REAUTHENTICATION_REQUIRED' });
			expect(updateFactor).not.toHaveBeenCalled();
			expect(createProof).not.toHaveBeenCalled();
		},
	);

	it('uses a conditional replay update before recording a single verified step-up', async () => {
		findProof.mockResolvedValue({ ...proof(), verifiedAt: null });
		await service.verify(TOKEN, PROOF, { method: 'totp', code: '123456' }, REQUEST);
		expect(updateFactor).toHaveBeenCalledWith({
			where: {
				id: FACTOR,
				platformStaffId: STAFF,
				version: 1,
				disabledAt: null,
				verifiedAt: { not: null },
				OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: 100n } }],
			},
			data: { lastAcceptedTimeStep: 100n, lastUsedAt: NOW },
		});
		expect(updateProof).toHaveBeenCalledWith(
			expect.objectContaining({ data: { verifiedAt: NOW } }),
		);
		findProof.mockResolvedValue({ ...proof(), verifiedAt: NOW });
		await expect(
			service.verify(TOKEN, PROOF, { method: 'totp', code: '123456' }, REQUEST),
		).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
	});

	it('rejects a TOTP step when another verifier already consumed it', async () => {
		findProof.mockResolvedValue({ ...proof(), verifiedAt: null });
		updateFactor.mockResolvedValueOnce({ count: 0 });
		await expect(
			service.verify(TOKEN, PROOF, { method: 'totp', code: '123456' }, REQUEST),
		).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(updateProof).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: { verifiedAt: NOW } }),
		);
	});

	it('rotates the recovery generation and revokes sessions before returning a new set', async () => {
		findProof.mockResolvedValue({ ...proof(), operation: 'recovery_regenerate', factorId: null });
		const codes = await service.regenerate(TOKEN, PROOF, REQUEST);
		expect(codes).toHaveLength(10);
		expect(tx.platformStaff.update).toHaveBeenCalledWith({
			where: { id: STAFF },
			data: { mfaVersion: { increment: 1 }, recoveryGeneration: { increment: 1 } },
		});
		expect(updateSession).toHaveBeenCalledWith({
			where: { platformStaffId: STAFF, revokedAt: null },
			data: { revokedAt: NOW, revocationReason: 'recovery_rotated' },
		});
		expect(updateCodes).toHaveBeenCalledWith({
			where: { platformStaffId: STAFF, usedAt: null },
			data: { usedAt: NOW },
		});
		expect(notify.mock.calls[0]?.[0]).toMatchObject({ data: { event: 'mfa_recovery_rotated' } });
	});

	it('changes only an owned factor label after consuming its specific proof', async () => {
		findProof.mockResolvedValue({ ...proof(), operation: 'factor_rename' });
		await service.rename(TOKEN, PROOF, FACTOR, ' Personal ', REQUEST);
		expect(renameFactor).toHaveBeenCalledWith({
			where: { platformStaffId: STAFF },
			data: { label: 'Personal' },
		});
		expect(updateFactor).not.toHaveBeenCalled();
	});

	it.each(['\nWork', ' ', 'a'.repeat(81)])(
		'rejects unsafe factor labels before mutation: %p',
		async (label) => {
			await expect(service.rename(TOKEN, PROOF, FACTOR, label, REQUEST)).rejects.toMatchObject({
				publicCode: 'VALIDATION_FAILED',
			});
			expect(renameFactor).not.toHaveBeenCalled();
		},
	);

	it('rejects a staff suspension that wins after initial session authentication', async () => {
		const current = session();
		findSession.mockResolvedValue({
			...current,
			platformStaff: { ...current.platformStaff, status: PlatformStaffStatus.SUSPENDED },
		});
		await expect(service.enroll(TOKEN, PROOF, 'Work', FACTOR, REQUEST)).rejects.toMatchObject({
			publicCode: 'UNAUTHENTICATED',
		});
		expect(createProof).not.toHaveBeenCalled();
	});

	it('keeps the old authenticator active while only an encrypted pending setup is persisted', async () => {
		const result = await service.enroll(TOKEN, PROOF, 'Replacement', FACTOR, REQUEST);
		expect(result.secret).toBe('JBSWY3DPEHPK3PXP');
		expect(JSON.stringify(createProof.mock.calls)).not.toContain(result.secret);
		expect(createProof.mock.calls[0]?.[0]).toMatchObject({
			data: { purpose: 'enrollment', operation: 'totp_replace' },
		});
		expect(updateFactor).not.toHaveBeenCalled();
	});

	it('requires proof from the new authenticator before replacement', async () => {
		findProof.mockResolvedValue({
			...proof(),
			...factor(),
			id: proof().id,
			factorId: FACTOR,
			purpose: 'enrollment',
			verifiedAt: null,
			operation: 'totp_replace',
		});
		verifyTotp.mockReturnValue(null);
		await expect(service.confirm(TOKEN, PROOF, '000000', FACTOR, REQUEST)).rejects.toMatchObject({
			publicCode: 'AUTH_MFA_INVALID',
		});
		expect(updateFactor).not.toHaveBeenCalled();
		expect(updateProof.mock.calls[0]?.[0]).toMatchObject({
			data: { failedAttempts: { increment: 1 } },
		});
	});

	it('returns fresh recovery values once and stores only purpose-separated verifiers', async () => {
		findProof.mockResolvedValue({
			...proof(),
			...factor(),
			id: proof().id,
			factorId: FACTOR,
			purpose: 'enrollment',
			verifiedAt: null,
			operation: 'totp_replace',
		});
		const codes = await service.confirm(TOKEN, PROOF, '123456', FACTOR, REQUEST);
		expect(codes).toHaveLength(10);
		expect(new Set(codes).size).toBe(10);
		expect(createCodes.mock.calls[0]?.[0]).toEqual({
			data: codes.map((code) => ({
				platformStaffId: STAFF,
				generation: 2,
				digestVersion: 2,
				codeDigest: tokens.recoveryCodeDigest(code),
				createdAt: NOW,
			})),
		});
		for (const code of codes) expect(JSON.stringify(createCodes.mock.calls)).not.toContain(code);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			data: { event: 'mfa_factor_replaced', recipient: 'owner@example.com' },
		});
	});

	it('denies removing the final factor after consuming and auditing the authorized attempt', async () => {
		findProof.mockResolvedValue({ ...proof(), operation: 'totp_remove' });
		await expect(service.remove(TOKEN, PROOF, FACTOR, REQUEST)).rejects.toMatchObject({
			publicCode: 'AUTH_MFA_FACTOR_CHANGE_DENIED',
		});
		expect(updateFactor).not.toHaveBeenCalled();
		expect(audit.mock.calls[0]?.[0]).toMatchObject({
			data: { action: 'mfa_factor_change_denied' },
		});
	});

	it('does not let recovery context regenerate recovery codes or manage unrelated settings', async () => {
		findSession.mockResolvedValue({ ...session(), authenticationMethod: 'recovery_code' });
		await expect(
			service.start(TOKEN, { operation: 'recovery_regenerate', password: 'current' }, REQUEST),
		).rejects.toMatchObject({ publicCode: 'ACCESS_DENIED' });
		expect(createCodes).not.toHaveBeenCalled();
	});

	it('lets the last recovery code authorize one repair only after fresh password verification', async () => {
		findSession.mockResolvedValue({ ...session(), authenticationMethod: 'recovery_code' });
		await expect(
			service.start(
				TOKEN,
				{ operation: 'totp_replace', factorId: FACTOR, password: 'current' },
				REQUEST,
			),
		).resolves.toMatchObject({ verified: true });
		expect(createProof.mock.calls[0]?.[0]).toMatchObject({
			data: { operation: 'totp_replace', verifiedAt: NOW },
		});
	});

	it('rejects a pending factor’s enrollment code as an existing step-up factor', async () => {
		const current = session();
		findSession.mockResolvedValue({
			...current,
			platformStaff: {
				...current.platformStaff,
				totpCredential: { ...factor(), verifiedAt: null },
			},
		});
		findProof.mockResolvedValue({ ...proof(), verifiedAt: null });
		await expect(
			service.verify(TOKEN, PROOF, { method: 'totp', code: '123456' }, REQUEST),
		).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(verifyTotp).not.toHaveBeenCalled();
	});

	it('fails closed if a required audit or notification cannot be persisted', async () => {
		findProof.mockResolvedValue({
			...proof(),
			...factor(),
			id: proof().id,
			factorId: FACTOR,
			purpose: 'enrollment',
			verifiedAt: null,
			operation: 'totp_replace',
		});
		notify.mockRejectedValueOnce(new Error('private provider/database details'));
		await expect(service.confirm(TOKEN, PROOF, '123456', FACTOR, REQUEST)).rejects.toMatchObject({
			publicCode: 'SERVICE_UNAVAILABLE',
		});
	});
});
