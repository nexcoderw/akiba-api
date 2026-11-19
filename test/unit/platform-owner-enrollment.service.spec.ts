import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService, type PlatformOwnerEnrollment } from '@nexcoderw/akiba-db';
import * as OTPAuth from 'otpauth';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { ResendEmailService } from '../../src/infrastructure/email/resend-email.service.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { PlatformTotpService } from '../../src/modules/platform/auth/platform-totp.service.js';
import { PlatformOwnerEnrollmentService } from '../../src/modules/platform/bootstrap/platform-owner-enrollment.service.js';

describe('first platform owner enrollment', () => {
	const now = new Date('2030-01-01T00:00:00.000Z');
	const staffId = 'a652ac64-47b5-499e-a849-dca02166c46b';
	const requestId = 'req_13863326-d953-4072-b1c9-9f4528098ad3';
	const config = new ConfigService<EnvironmentVariables, true>({
		...validateEnvironment({ NODE_ENV: 'test' }),
		PLATFORM_OWNER_BOOTSTRAP_ENABLED: true,
		RESEND_API_KEY: 're_fictional', RESEND_FROM_EMAIL: 'security@example.com',
	});
	const tokens = new PlatformTokenService(config);
	const mailboxToken = 'a'.repeat(43);
	const sessionToken = 'b'.repeat(43);
	let row: PlatformOwnerEnrollment;
	let staff: ReturnType<typeof pendingStaff>;
	let service: PlatformOwnerEnrollmentService;
	const count = jest.fn<() => Promise<number>>();
	const findUnique = jest.fn<() => Promise<unknown>>();
	const update = jest.fn<(input: { data: Record<string, unknown> }) => Promise<unknown>>();
	const createPassword = jest.fn<() => Promise<unknown>>();
	const createFactor = jest.fn<() => Promise<unknown>>();
	const createCodes = jest.fn<() => Promise<unknown>>();
	const createAudit = jest.fn<() => Promise<unknown>>();
	const sendEmail = jest.fn<() => Promise<void>>();
	const hashPassword = jest.fn<() => Promise<string>>();
	const upsert = jest.fn<(input: { create: Record<string, unknown> }) => Promise<unknown>>();
	const acknowledge = jest.fn<() => Promise<{ count: number }>>();
	const transaction = {
		$queryRaw: jest.fn(async (query: TemplateStringsArray) =>
			query.join('').includes('advisory') ? [{ acquired: true }] : [{ now }]),
		platformStaff: {
			count,
			findFirst: jest.fn(async () => staff),
			update: jest.fn(async () => ({ recoveryGeneration: 2 })),
		},
		platformOwnerEnrollment: { findUnique, update, upsert, updateMany: acknowledge },
		passwordCredential: { create: createPassword },
		platformTotpCredential: { create: createFactor },
		platformRecoveryCode: { createMany: createCodes },
		identitySecurityAuditEvent: { create: createAudit },
		user: { update: jest.fn(async () => ({ ...staff.user, identityVersion: 2 })) },
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({ providers: [
			PlatformOwnerEnrollmentService, PlatformTotpService,
			{ provide: ConfigService, useValue: config },
			{ provide: PlatformTokenService, useValue: tokens },
			{ provide: PlatformPasswordService, useValue: { hash: hashPassword } },
			{ provide: ResendEmailService, useValue: { sendOwnerEnrollment: sendEmail } },
			{ provide: PrismaService, useValue: {
				$transaction: (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction),
			} },
		] }).compile();
		service = module.get(PlatformOwnerEnrollmentService);
	});

	beforeEach(() => {
		jest.clearAllMocks();
		staff = pendingStaff();
		row = {
			id: 'b77c704a-b8c7-40d2-b2af-2bbbdbf081b5', platformStaffId: staffId,
			email: 'owner@example.com', identityVersion: 1,
			tokenDigest: tokens.digest(JSON.stringify(['platform-owner-enrollment-v1', 'mailbox', mailboxToken])),
			sessionDigest: tokens.digest(JSON.stringify(['platform-owner-enrollment-v1', 'session', sessionToken])),
			createdAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + 900_000),
			sentAt: new Date(now.getTime() - 50_000), exchangedAt: now, consumedAt: null,
			sendCount: 1, failedAttempts: 0, setupVersion: 0, passwordHash: null,
			encryptedSecret: null, encryptionKeyId: null, encryptionVersion: null,
			initializationVector: null, authenticationTag: null,
		};
		count.mockResolvedValue(1);
		findUnique.mockImplementation(async () => structuredClone(row));
		hashPassword.mockResolvedValue('fictional-reviewed-hash');
		sendEmail.mockReset().mockResolvedValue(undefined);
		acknowledge.mockResolvedValue({ count: 1 });
		upsert.mockImplementation(async ({ create }) => {
			Object.assign(row, create);
			return structuredClone(row);
		});
		update.mockImplementation(async ({ data }) => {
			const attempts = data.failedAttempts;
			Object.assign(row, data);
			if (typeof attempts === 'object' && attempts !== null) row.failedAttempts = 1;
			return row;
		});
	});

	function pendingStaff() {
		return {
			id: staffId, userId: '2f5298af-cf42-4e66-8968-a42be74cb34b', status: 'PENDING',
			user: {
				id: '2f5298af-cf42-4e66-8968-a42be74cb34b', email: 'owner@example.com',
				identityVersion: 1, status: 'PENDING', emailVerifiedAt: null, passwordCredential: null,
			},
			totpCredential: null, roles: [{ platformRole: { key: 'platform.owner', isSystem: true } }],
		};
	}

	it('bounds operator delivery and never acknowledges an uncertain provider submission', async () => {
		row.sendCount = 3;
		await expect(service.send()).rejects.toMatchObject({ publicCode: 'RATE_LIMITED' });
		expect(sendEmail).not.toHaveBeenCalled();
		row.sendCount = 1;
		row.createdAt = now;
		await expect(service.send()).rejects.toMatchObject({ publicCode: 'RATE_LIMITED' });
		row.createdAt = new Date(now.getTime() - 60_000);
		sendEmail.mockRejectedValueOnce(new Error('Synthetic uncertain delivery'));
		await expect(service.send()).rejects.toThrow('Synthetic uncertain delivery');
		expect(row.sentAt).toBeNull();
		expect(row.sessionDigest).toBeNull();
		expect(acknowledge).not.toHaveBeenCalled();
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it('stages a password without activating credentials, and rejects a second password write', async () => {
		await expect(service.password(sessionToken, 'a unique fictional passphrase', requestId))
			.resolves.toMatchObject({ stage: 'mfa' });
		expect(row.passwordHash).toBe('fictional-reviewed-hash');
		expect(createPassword).not.toHaveBeenCalled();
		await expect(service.password(sessionToken, 'another fictional passphrase', requestId))
			.rejects.toMatchObject({ publicCode: 'RESOURCE_CONFLICT' });
	});

	it('does not exchange an undelivered, used or expired mailbox proof', async () => {
		row.sentAt = null;
		await expect(service.exchange(mailboxToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		row.sentAt = now;
		await expect(service.exchange(mailboxToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		row.exchangedAt = null;
		row.expiresAt = now;
		await expect(service.exchange(mailboxToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(update).not.toHaveBeenCalled();
	});

	it('exchanges once for a different browser proof without creating credentials', async () => {
		row.exchangedAt = null;
		row.sessionDigest = null;
		const result = await service.exchange(mailboxToken);
		expect(result.stage).toBe('password');
		expect(result.token).not.toBe(mailboxToken);
		await expect(service.exchange(mailboxToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(createPassword).not.toHaveBeenCalled();
		expect(createFactor).not.toHaveBeenCalled();
	});

	it.each(['ACTIVE', 'SUSPENDED', 'REVOKED'])('never repairs a %s owner', async (status) => {
		staff.status = status;
		await expect(service.status(sessionToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
	});

	it('rejects lookalike roles, identity changes and exhausted proofs', async () => {
		const role = staff.roles[0];
		if (role === undefined) throw new Error('Missing fixture role.');
		role.platformRole.isSystem = false;
		await expect(service.status(sessionToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		staff = pendingStaff();
		row.identityVersion = 2;
		await expect(service.status(sessionToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		row.identityVersion = 1;
		row.failedAttempts = 5;
		await expect(service.status(sessionToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
	});

	it('requires a password and bounds key regeneration without resetting attempts', async () => {
		await expect(service.setup(sessionToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		row.passwordHash = 'fictional-reviewed-hash';
		row.failedAttempts = 2;
		const first = await service.setup(sessionToken);
		const second = await service.setup(sessionToken);
		expect(first.secret).not.toBe(second.secret);
		expect(second.version).toBe(2);
		expect(row.failedAttempts).toBe(2);
		await service.setup(sessionToken);
		await expect(service.setup(sessionToken)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
	});

	it('rejects stale setup versions before activating any credential', async () => {
		row.passwordHash = 'fictional-reviewed-hash';
		await service.setup(sessionToken);
		await expect(service.complete(sessionToken, '123456', 2, requestId)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(createPassword).not.toHaveBeenCalled();
	});

	it('commits a failed verification attempt without issuing credentials', async () => {
		row.passwordHash = 'fictional-reviewed-hash';
		await service.setup(sessionToken);
		await expect(service.complete(sessionToken, 'invalid', 1, requestId)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(row.failedAttempts).toBe(1);
		expect(createPassword).not.toHaveBeenCalled();
	});

	it('activates only after actual TOTP confirmation and never discloses recovery codes again', async () => {
		row.passwordHash = 'fictional-reviewed-hash';
		const setup = await service.setup(sessionToken);
		const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret), period: 30, digits: 6, algorithm: 'SHA1' }).generate({ timestamp: now.getTime() });
		const result = await service.complete(sessionToken, code, setup.version, requestId);
		expect(result.recoveryCodes).toHaveLength(10);
		expect(new Set(result.recoveryCodes).size).toBe(10);
		expect(createCodes).toHaveBeenCalledWith({ data: expect.arrayContaining([
			expect.objectContaining({ digestVersion: 2, generation: 2 }),
		]) });
		expect(row.consumedAt).toEqual(now);
		expect(row.encryptedSecret).toBeNull();
		expect(row.passwordHash).toBeNull();
		await expect(service.complete(sessionToken, code, setup.version, requestId)).rejects.toMatchObject({ publicCode: 'AUTH_MFA_INVALID' });
		expect(createPassword).toHaveBeenCalledTimes(1);
	});
});
