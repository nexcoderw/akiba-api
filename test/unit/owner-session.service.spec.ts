import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OwnerSessionAssurance, PrismaService } from '@nexcoderw/akiba-db';

import { OwnerSessionService } from '../../src/modules/owner/auth/owner-session.service.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';

describe('OwnerSessionService connection recovery', () => {
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
					.create('11111111-1111-4111-8111-111111111111', OwnerSessionAssurance.AAL1),
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
