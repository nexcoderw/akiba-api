import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { OwnerSessionService } from '../../src/modules/owner/auth/owner-session.service.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';
import { OwnerEnrollmentService } from '../../src/modules/owner/enrollment/owner-enrollment.service.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { OwnerInvitationTokenService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token.service.js';

it('registers with the saved invitation name and the MFA password minimum', async () => {
	const now = new Date('2026-11-27T12:00:00Z');
	const expiresAt = new Date('2026-11-27T12:10:00Z');
	const user = { id: 'test-owner', identityVersion: 1 };
	const create = jest.fn(() => Promise.resolve(user));
	const hashForMfaEnrollment = jest.fn((password: Buffer) => {
		expect(password.toString('utf8')).toBe('test-X7!');
		return Promise.resolve('synthetic-password-hash');
	});
	const tx = {
		user: { create },
		organizationOwnerEnrollmentChallenge: { updateMany: () => Promise.resolve({ count: 1 }) },
		identitySecurityAuditEvent: { create: () => Promise.resolve({ id: 'test-audit' }) },
	};
	const module = await Test.createTestingModule({
		providers: [
			OwnerEnrollmentService,
			{ provide: ConfigService, useValue: { get: () => 600 } },
			{ provide: OwnerInvitationTokenService, useValue: {} },
			{
				provide: OwnerTokenService,
				useValue: { isValid: () => true, enrollmentDigest: () => 'synthetic-digest' },
			},
			{ provide: PlatformPasswordService, useValue: { hashForMfaEnrollment } },
			{
				provide: OwnerSessionService,
				useValue: { create: () => Promise.resolve({ token: 'synthetic-session', expiresAt }) },
			},
			{
				provide: PrismaService,
				useValue: {
					organizationOwnerEnrollmentChallenge: {
						findUnique: () =>
							Promise.resolve({
								id: 'test-challenge',
								organizationId: 'test-organization',
								status: 'PENDING',
								purpose: 'NEW_USER_ENROLLMENT',
								failedAttempts: 0,
								maxAttempts: 5,
								expiresAt,
								user: null,
								ownerInvitation: {
									invitedEmail: 'owner@example.com',
									invitedDisplayName: 'Aline Uwase',
								},
							}),
					},
					$transaction: (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
				},
			},
		],
	}).compile();
	try {
		const service = module.get(OwnerEnrollmentService);
		await expect(
			service.register(
				{ challengeToken: 'synthetic-token', password: 'test-X7!', displayName: 'Legacy name' },
				now,
			),
		).resolves.toMatchObject({ status: 'verified' });
		expect(hashForMfaEnrollment).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ displayName: 'Aline Uwase' }),
			}),
		);
	} finally {
		await module.close();
	}
});
