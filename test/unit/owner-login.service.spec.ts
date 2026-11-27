import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { OwnerEmailOtpService } from '../../src/modules/owner/auth/owner-email-otp.service.js';
import { OwnerLoginAttemptService } from '../../src/modules/owner/auth/owner-login-attempt.service.js';
import { OwnerLoginService } from '../../src/modules/owner/auth/owner-login.service.js';
import { OwnerSessionService } from '../../src/modules/owner/auth/owner-session.service.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';
import { ApiProblemException } from '../../src/common/errors/api-problem.exception.js';

describe('owner login assurance boundary with the real session service', () => {
	const findUnique = jest.fn<() => Promise<unknown>>();
	const transaction = jest.fn<() => Promise<unknown>>();
	const createToken = jest.fn<() => string>();
	const consume = jest.fn<() => void>();
	const send = jest.fn<() => Promise<unknown>>();
	const verifyPassword = jest.fn<() => Promise<boolean>>();
	let module: TestingModule;
	let service: OwnerLoginService;

	beforeAll(async () => {
		module = await Test.createTestingModule({
			providers: [
				OwnerLoginService,
				{ provide: OwnerEmailOtpService, useValue: { assertEnabled: () => undefined, send } },
				OwnerSessionService,
				{ provide: PrismaService, useValue: { user: { findUnique }, $transaction: transaction } },
				{ provide: ConfigService, useValue: { get: () => 1800 } },
				{ provide: OwnerTokenService, useValue: { create: createToken } },
				{
					provide: PlatformPasswordService,
					useValue: {
						dummyHash: 'synthetic-dummy',
						verify: verifyPassword,
					},
				},
				{
					provide: OwnerLoginAttemptService,
					useValue: {
						consume,
					},
				},
			],
		}).compile();
		service = module.get(OwnerLoginService);
	});

	afterAll(async () => {
		await module.close();
	});
	beforeEach(() => {
		jest.clearAllMocks();
		verifyPassword.mockResolvedValue(true);
	});
	it('rejects exhausted admission before identity lookup or session work', async () => {
		consume.mockImplementationOnce(() => {
			throw new ApiProblemException('RATE_LIMITED');
		});
		await expect(
			service.login({ email: 'owner@example.com', password: 'fictional password' }, '192.0.2.1'),
		).rejects.toMatchObject({ publicCode: 'RATE_LIMITED' });
		expect(findUnique).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		expect(createToken).not.toHaveBeenCalled();
	});

	it.each([
		{ eligible: true, validPassword: true },
		{ eligible: false, validPassword: false },
		{ eligible: true, validPassword: false },
	])(
		'does not issue a session at password verification: %j',
		async ({ eligible, validPassword }) => {
			verifyPassword.mockResolvedValue(validPassword);
			findUnique.mockResolvedValue(
				eligible
					? {
							id: '11111111-1111-4111-8111-111111111111',
							email: 'owner@example.com',
							identityVersion: 1,
							status: 'ACTIVE',
							emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
							platformStaff: null,
							passwordCredential: {
								passwordHash: 'synthetic-hash',
								normalization: 'raw',
								version: 1,
								disabledAt: null,
							},
							organizationMemberships: [
								{
									id: 'membership',
									organizationId: 'organization',
									roles: [{ organizationRole: { key: 'owner', isSystem: true, isActive: true } }],
								},
							],
						}
					: null,
			);
			const challenge = { status: 'email_otp_required' };
			send.mockResolvedValue(challenge);
			const result = service.login(
				{ email: 'owner@example.com', password: 'fictional password' },
				'127.0.0.1',
				new Date('2026-11-14T00:00:00Z'),
				'kimihurura',
			);
			if (eligible && validPassword) await expect(result).resolves.toEqual(challenge);
			else if (eligible) await expect(result).rejects.toMatchObject({ status: 401 });
			else await expect(result).rejects.toMatchObject({ publicCode: 'OWNER_ACCOUNT_NOT_FOUND' });
			expect(send).toHaveBeenCalledTimes(eligible && validPassword ? 1 : 0);
			expect(createToken).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
			expect(consume).toHaveBeenCalledTimes(1);
		},
	);
});
