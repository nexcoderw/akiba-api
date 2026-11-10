import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PlatformStaffStatus, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { ResendEmailService } from '../../src/infrastructure/email/resend-email.service.js';
import { PlatformEmailOtpService } from '../../src/modules/platform/auth/platform-email-otp.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';

describe('PlatformEmailOtpService', () => {
	const findUnique = jest.fn<() => Promise<unknown>>();
	const updateMany = jest.fn<(input: unknown) => Promise<{ count: number }>>();
	const sendOtp = jest.fn<ResendEmailService['sendOtp']>();
	const now = new Date('2030-01-01T00:00:00.000Z');
	let service: PlatformEmailOtpService;
	let config: ConfigService<EnvironmentVariables, true>;

	beforeAll(async () => {
		config = new ConfigService<EnvironmentVariables, true>({
			...validateEnvironment({
				NODE_ENV: 'test',
				PLATFORM_AUTH_EMAIL_OTP_ENABLED: 'true',
				RESEND_API_KEY: 're_fictional',
				RESEND_FROM_EMAIL: 'security@example.com',
			}),
		});
		const module = await Test.createTestingModule({
			providers: [
				PlatformEmailOtpService,
				{ provide: ConfigService, useValue: config },
				{ provide: PrismaService, useValue: { platformMfaChallenge: { findUnique, updateMany } } },
				{ provide: ResendEmailService, useValue: { sendOtp } },
				{
					provide: PlatformTokenService,
					useValue: { digest: () => 'challenge-digest', emailOtpDigest: () => 'keyed-otp-digest' },
				},
			],
		}).compile();
		service = module.get(PlatformEmailOtpService);
	});
	beforeEach(() => {
		jest.clearAllMocks();
		config.set('PLATFORM_AUTH_EMAIL_OTP_ENABLED', true);
		findUnique.mockResolvedValue(challenge());
		updateMany.mockResolvedValue({ count: 1 });
		sendOtp.mockResolvedValue(undefined);
	});

	it('rejects disabled email verification before reading the database', async () => {
		config.set('PLATFORM_AUTH_EMAIL_OTP_ENABLED', false);
		await expect(service.send('fictional-challenge-token', now)).rejects.toMatchObject({
			status: 401,
		});
		expect(findUnique).not.toHaveBeenCalled();
		expect(sendOtp).not.toHaveBeenCalled();
	});

	it('sends only to the verified account and stores no plaintext code', async () => {
		await expect(service.send('fictional-challenge-token', now)).resolves.toEqual({
			status: 'sent',
			expiresAt: '2030-01-01T00:05:00.000Z',
			retryAfterSeconds: 60,
		});
		expect(sendOtp).toHaveBeenCalledWith(
			'admin@example.com',
			expect.stringMatching(/^\d{6}$/u),
			expect.any(String),
		);
		expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
			data: {
				emailOtpDigest: 'keyed-otp-digest',
				emailOtpSendCount: { increment: 1 },
			},
		});
		const plaintext = sendOtp.mock.calls[0]?.[1];
		expect(plaintext).toBeDefined();
		expect(JSON.stringify(updateMany.mock.calls)).not.toContain(plaintext);
	});
	it.each([{ consumedAt: now }, { expiresAt: now }, { failedAttempts: 5 }])(
		'rejects invalid challenges without sending: %p',
		async (state) => {
			findUnique.mockResolvedValue({ ...challenge(), ...state });
			await expect(service.send('fictional-challenge-token', now)).rejects.toMatchObject({
				status: 401,
			});
			expect(sendOtp).not.toHaveBeenCalled();
		},
	);
	it.each([{ emailOtpSendCount: 3 }, { emailOtpSentAt: now }])(
		'enforces durable send limits: %p',
		async (state) => {
			findUnique.mockResolvedValue({ ...challenge(), ...state });
			await expect(service.send('fictional-challenge-token', now)).rejects.toMatchObject({
				status: 429,
			});
			expect(updateMany).not.toHaveBeenCalled();
			expect(sendOtp).not.toHaveBeenCalled();
		},
	);
	it('allows verified system owners without per-permission grants to request their email factor', async () => {
		const owner = challenge();
		owner.platformStaff.roles = [
			{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } },
		];
		findUnique.mockResolvedValue(owner);
		await expect(service.send('fictional-challenge-token', now)).resolves.toMatchObject({
			status: 'sent',
		});
		expect(sendOtp).toHaveBeenCalledTimes(1);
	});

	it('does not send after losing the compare-and-set race', async () => {
		updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(service.send('fictional-challenge-token', now)).rejects.toMatchObject({
			status: 429,
		});
		expect(sendOtp).not.toHaveBeenCalled();
	});
	it('invalidates a failed delivery without refunding its abuse quota', async () => {
		sendOtp.mockRejectedValueOnce(new Error('fictional provider failure'));
		await expect(service.send('fictional-challenge-token', now)).rejects.toThrow(
			'fictional provider failure',
		);
		expect(updateMany).toHaveBeenLastCalledWith({
			where: { id: 'challenge-id', emailOtpDigest: 'keyed-otp-digest' },
			data: { emailOtpDigest: null, emailOtpExpiresAt: null },
		});
		expect(sendOtp).toHaveBeenCalledTimes(1);
	});
	it('rejects unverified recipients without contacting the provider', async () => {
		const record = challenge();
		findUnique.mockResolvedValue({
			...record,
			platformStaff: {
				...record.platformStaff,
				user: { ...record.platformStaff.user, emailVerifiedAt: null },
			},
		});
		await expect(service.send('fictional-challenge-token', now)).rejects.toMatchObject({
			status: 401,
		});
		expect(sendOtp).not.toHaveBeenCalled();
	});
});

function challenge() {
	return {
		id: 'challenge-id',
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
		consumedAt: null,
		expiresAt: new Date('2030-01-01T00:05:00.000Z'),
		failedAttempts: 0,
		maxAttempts: 5,
		emailOtpSendCount: 0,
		emailOtpSentAt: null,
		platformStaff: {
			status: PlatformStaffStatus.ACTIVE,
			user: {
				status: UserStatus.ACTIVE,
				email: 'admin@example.com',
				emailVerifiedAt: new Date('2029-01-01T00:00:00.000Z'),
				passwordCredential: { passwordChangedAt: new Date('2029-01-01T00:00:00.000Z') },
			},
			roles: [
				{
					platformRole: {
						key: 'platform.operator',
						isSystem: false,
						permissions: [{ platformPermissionId: 'permission-id' }],
					},
				},
			],
		},
	};
}
