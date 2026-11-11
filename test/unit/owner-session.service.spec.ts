import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OwnerSessionAssurance, PrismaService } from '@nexcoderw/akiba-db';

import { OwnerSessionService } from '../../src/modules/owner/auth/owner-session.service.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';

describe('OwnerSessionService connection recovery', () => {
	it('persists a digest and the verified membership, never the raw session token', async () => {
		const token = 'a'.repeat(43);
		const userId = '11111111-1111-4111-8111-111111111111';
		const organizationId = '22222222-2222-4222-8222-222222222222';
		const membershipId = '33333333-3333-4333-8333-333333333333';
		const create = jest.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue({});
		const client = {
			$queryRaw: () => Promise.resolve([{ id: userId }]),
			organizationMembership: { findFirst: () => Promise.resolve({ id: membershipId }) },
			ownerSession: { count: () => Promise.resolve(0), create },
		};
		const module = await Test.createTestingModule({
			providers: [
				OwnerSessionService,
				{
					provide: PrismaService,
					useValue: {
						$transaction: (operation: (transaction: typeof client) => Promise<unknown>) =>
							operation(client),
					},
				},
				{
					provide: ConfigService,
					useValue: {
						get: (key: string) => (key === 'DATABASE_CONNECTION_TIMEOUT_MS' ? 10_000 : 1800),
					},
				},
				{
					provide: OwnerTokenService,
					useValue: { create: () => token, sessionDigest: () => 'digest' },
				},
			],
		}).compile();
		try {
			const result = await module
				.get(OwnerSessionService)
				.create(
					userId,
					{ organizationId, membershipId },
					OwnerSessionAssurance.AAL1,
					new Date('2026-01-01T00:00:00.000Z'),
				);
			expect(result.token).toBe(token);
			expect(create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					userId,
					organizationId,
					membershipId,
					tokenDigest: 'digest',
				}),
			});
			expect(JSON.stringify(create.mock.calls)).not.toContain(token);
		} finally {
			await module.close();
		}
	});
	it('allows only one atomic replacement when the same token is rotated concurrently', async () => {
		const now = new Date('2026-01-02T00:00:00.000Z');
		let live = true;
		const create = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
		const client = {
			ownerSession: {
				findUnique: () =>
					Promise.resolve({
						authenticatedAt: new Date('2026-01-01T00:00:00.000Z'),
						mfaVerifiedAt: null,
						absoluteExpiresAt: new Date('2026-01-02T08:00:00.000Z'),
					}),
				updateMany: () => {
					const count = live ? 1 : 0;
					live = false;
					return Promise.resolve({ count });
				},
				create,
			},
		};
		const module = await Test.createTestingModule({
			providers: [
				OwnerSessionService,
				{
					provide: PrismaService,
					useValue: {
						$transaction: (operation: (transaction: typeof client) => Promise<unknown>) =>
							operation(client),
					},
				},
				{
					provide: ConfigService,
					useValue: {
						get: (key: string) => (key === 'DATABASE_CONNECTION_TIMEOUT_MS' ? 10_000 : 1800),
					},
				},
				{
					provide: OwnerTokenService,
					useValue: { create: () => 'replacement-token', sessionDigest: () => 'digest' },
				},
			],
		}).compile();
		try {
			const service = module.get(OwnerSessionService);
			jest.spyOn(service, 'authenticate').mockResolvedValue({
				sessionId: '33333333-3333-4333-8333-333333333333',
				userId: '55555555-5555-4555-8555-555555555555',
				displayName: 'Fictional Owner',
				email: 'owner@example.test',
				assurance: 'AAL1',
				expiresAt: new Date('2026-01-02T08:00:00.000Z'),
				organizations: [
					{
						organizationId: '11111111-1111-4111-8111-111111111111',
						membershipId: '22222222-2222-4222-8222-222222222222',
						name: 'Fictional Shop',
						slug: 'fictional',
						status: 'ACTIVE',
						roles: ['owner'],
					},
				],
			});
			const results = await Promise.allSettled([
				service.rotate('old-token', now),
				service.rotate('old-token', now),
			]);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
			expect(create).toHaveBeenCalledTimes(1);
		} finally {
			await module.close();
		}
	});
	it('derives exactly one organization from the stored membership and scopes remote revocation', async () => {
		const now = new Date('2026-01-02T00:00:00.000Z');
		const organizationId = '11111111-1111-4111-8111-111111111111';
		const membershipId = '22222222-2222-4222-8222-222222222222';
		const sessionId = '33333333-3333-4333-8333-333333333333';
		const selectedId = '44444444-4444-4444-8444-444444444444';
		const updateMany = jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({ count: 1 });
		const row = {
			id: sessionId,
			organizationId,
			membershipId,
			enrollmentChallengeId: null,
			enrollmentChallenge: null,
			assurance: OwnerSessionAssurance.AAL1,
			authenticatedAt: new Date('2026-01-01T00:00:00.000Z'),
			idleExpiresAt: new Date('2026-01-02T00:20:00.000Z'),
			absoluteExpiresAt: new Date('2026-01-02T08:00:00.000Z'),
			revokedAt: null,
			membership: {
				id: membershipId,
				status: 'ACTIVE',
				organization: {
					id: organizationId,
					name: 'Fictional Shop',
					slug: 'fictional',
					status: 'ACTIVE',
				},
				roles: [{ organizationRole: { key: 'owner' } }],
			},
			user: {
				id: '55555555-5555-4555-8555-555555555555',
				displayName: 'Fictional Owner',
				email: 'owner@example.test',
				status: 'ACTIVE',
				emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
				passwordCredential: {
					disabledAt: null,
					passwordChangedAt: new Date('2025-01-01T00:00:00.000Z'),
				},
			},
		};
		const client = { ownerSession: { findUnique: () => Promise.resolve(row), updateMany } };
		const module = await Test.createTestingModule({
			providers: [
				OwnerSessionService,
				{
					provide: PrismaService,
					useValue: {
						$transaction: (operation: (transaction: typeof client) => Promise<unknown>) =>
							operation(client),
						ownerSession: { updateMany },
					},
				},
				{
					provide: ConfigService,
					useValue: {
						get: (key: string) => (key === 'DATABASE_CONNECTION_TIMEOUT_MS' ? 10_000 : 1800),
					},
				},
				{ provide: OwnerTokenService, useValue: { sessionDigest: () => 'digest' } },
			],
		}).compile();
		try {
			const service = module.get(OwnerSessionService);
			const principal = await service.authenticate('opaque-token', now);
			expect(principal.organizations).toHaveLength(1);
			expect(principal.organizations[0]?.organizationId).toBe(organizationId);
			await expect(service.revokeSelected('opaque-token', selectedId, now)).resolves.toBe(true);
			expect(updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: selectedId,
						userId: row.user.id,
						organizationId,
						membershipId,
					}),
				}),
			);
		} finally {
			await module.close();
		}
	});
	it('refuses session creation when post-password identity or credential eligibility changed', async () => {
		const queryRaw = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
		const create = jest.fn<() => Promise<unknown>>();
		const transaction = { $queryRaw: queryRaw, ownerSession: { create } };
		const module = await Test.createTestingModule({
			providers: [
				OwnerSessionService,
				{
					provide: PrismaService,
					useValue: {
						$transaction: (operation: (client: typeof transaction) => Promise<unknown>) =>
							operation(transaction),
					},
				},
				{ provide: ConfigService, useValue: { get: () => 10_000 } },
				{
					provide: OwnerTokenService,
					useValue: { create: () => 'fictional-token', sessionDigest: () => 'digest' },
				},
			],
		}).compile();
		try {
			await expect(
				module
					.get(OwnerSessionService)
					.create(
						'11111111-1111-4111-8111-111111111111',
						{
							organizationId: '22222222-2222-4222-8222-222222222222',
							membershipId: '33333333-3333-4333-8333-333333333333',
						},
						OwnerSessionAssurance.AAL1,
					),
			).rejects.toMatchObject({ status: 401 });
			expect(create).not.toHaveBeenCalled();
			expect(queryRaw.mock.calls[0]?.[0]).toEqual(
				expect.arrayContaining([expect.stringContaining('credential.disabled_at IS NULL')]),
			);
		} finally {
			await module.close();
		}
	});

	it.each([
		{ scenario: 'fast connection failure', inside: false, slow: false, attempts: 2 },
		{ scenario: 'failure inside transaction', inside: true, slow: false, attempts: 1 },
		{ scenario: 'slow connection failure', inside: false, slow: true, attempts: 1 },
	])('bounds retries for $scenario', async ({ inside, slow, attempts }) => {
		const error = Object.assign(new Error('Database unreachable'), { code: 'P1001' });
		const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
		const client = {
			ownerSession: { findUnique: () => Promise.reject(error) },
		};
		const transaction =
			jest.fn<(operation: (value: typeof client) => Promise<unknown>) => Promise<unknown>>();
		transaction.mockImplementation((operation) => {
			if (slow) clock.mockReturnValue(1_001);
			return inside ? operation(client) : Promise.reject(error);
		});
		const module = await Test.createTestingModule({
			providers: [
				OwnerSessionService,
				{ provide: PrismaService, useValue: { $transaction: transaction } },
				{ provide: ConfigService, useValue: { get: () => 10_000 } },
				{ provide: OwnerTokenService, useValue: { sessionDigest: () => 'digest' } },
			],
		}).compile();
		try {
			await expect(module.get(OwnerSessionService).authenticate('token')).rejects.toMatchObject({
				response: { code: 'OWNER_SESSION_UNAVAILABLE' },
			});
			expect(transaction).toHaveBeenCalledTimes(attempts);
		} finally {
			clock.mockRestore();
			await module.close();
		}
	});
});
