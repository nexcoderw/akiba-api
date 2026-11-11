import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PlatformStaffStatus, Prisma, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { PLATFORM_PERMISSION } from '../../src/modules/platform/auth/platform-permission.constants.js';

describe('PlatformSessionService', () => {
	const sessionFindUnique = jest.fn<() => Promise<unknown>>();
	const sessionUpdateMany = jest.fn<() => Promise<{ count: number }>>();
	const auditCreate = jest.fn<(input: unknown) => Promise<unknown>>();
	const transaction = {
		identitySecurityAuditEvent: { create: auditCreate },
		platformAdminSession: {
			findUnique: sessionFindUnique,
			updateMany: sessionUpdateMany,
		},
	};
	type TransactionOperation = (client: typeof transaction) => Promise<unknown>;
	const runTransaction = jest
		.fn<(operation: TransactionOperation, options?: unknown) => Promise<unknown>>()
		.mockImplementation((operation) => operation(transaction));
	let service: PlatformSessionService;

	beforeAll(async () => {
		const config = new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({ NODE_ENV: 'test' }),
		);
		const module = await Test.createTestingModule({
			providers: [
				PlatformSessionService,
				{ provide: ConfigService, useValue: config },
				{
					provide: PrismaService,
					useValue: {
						platformAdminSession: { updateMany: sessionUpdateMany },
						$transaction: runTransaction,
					},
				},
				{
					provide: PlatformTokenService,
					useValue: { digest: jest.fn<(value: string) => string>().mockReturnValue('digest') },
				},
			],
		}).compile();
		service = module.get(PlatformSessionService);
	});

	beforeEach(() => {
		jest.clearAllMocks();
		sessionUpdateMany.mockResolvedValue({ count: 1 });
		auditCreate.mockResolvedValue({ id: 'audit-id' });
	});

	it('scopes selected remote revocation to the authenticated platform staff identity', async () => {
		const selectedId = '11111111-1111-4111-8111-111111111111';
		const now = new Date('2030-01-01T00:10:00.000Z');
		const authenticate = jest.spyOn(service, 'authenticate').mockResolvedValue({
			sessionId: 'session-id',
			userId: 'user-id',
			platformStaffId: 'staff-id',
			displayName: 'Fictional Staff',
			email: 'staff@example.test',
			expiresAt: new Date('2030-01-01T08:00:00.000Z'),
			roles: [],
			permissions: [],
		});
		try {
			await expect(service.revokeSelected('opaque-token', selectedId, now)).resolves.toBe(true);
			expect(sessionUpdateMany).toHaveBeenCalledWith({
				where: { id: selectedId, platformStaffId: 'staff-id', revokedAt: null },
				data: { revokedAt: now, revocationReason: 'remote' },
			});
		} finally {
			authenticate.mockRestore();
		}
	});

	it('returns current database roles and permissions and advances idle expiry', async () => {
		sessionFindUnique.mockResolvedValue(
			createSession([{ platformPermission: { key: 'platform.dashboard.read' } }]),
		);

		await expect(
			service.authenticate(
				'fictional-session-token-with-more-than-32-characters',
				new Date('2030-01-01T00:10:00.000Z'),
			),
		).resolves.toMatchObject({
			roles: ['platform.operator'],
			permissions: ['platform.dashboard.read'],
		});
		expect(sessionUpdateMany).toHaveBeenCalledTimes(1);
		expect(runTransaction.mock.calls[0]?.[1]).toMatchObject({
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 10_000,
		});
	});

	it('reads live authorization on every request without rewriting a recently refreshed session', async () => {
		sessionFindUnique.mockResolvedValue(createSession([], 'platform.owner', true));
		const now = new Date('2030-01-01T00:00:01.000Z');
		await service.authenticate('fictional-session-token', now);
		await service.authenticate('fictional-session-token', now);
		expect(sessionFindUnique).toHaveBeenCalledTimes(2);
		expect(sessionUpdateMany).not.toHaveBeenCalled();
		sessionFindUnique.mockResolvedValue(createSession([]));
		await expect(service.authenticate('fictional-session-token', now)).rejects.toMatchObject({
			status: 401,
		});
	});

	it('refreshes after the coalescing interval and never extends the absolute expiry', async () => {
		const session = createSession([], 'platform.owner', true);
		sessionFindUnique.mockResolvedValue({
			...session,
			expiresAt: new Date('2030-01-01T00:30:35.000Z'),
		});
		await service.authenticate('fictional-session-token', new Date('2030-01-01T00:01:00.000Z'));
		expect(sessionUpdateMany).toHaveBeenCalledWith({
			where: {
				id: session.id,
				revokedAt: null,
				expiresAt: { gt: new Date('2030-01-01T00:01:00.000Z') },
				idleExpiresAt: { gt: new Date('2030-01-01T00:01:00.000Z') },
			},
			data: {
				lastSeenAt: new Date('2030-01-01T00:01:00.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:35.000Z'),
			},
		});
	});

	it('does not rewrite a session whose idle deadline already equals its absolute deadline', async () => {
		const session = createSession([], 'platform.owner', true);
		sessionFindUnique.mockResolvedValue({ ...session, expiresAt: session.idleExpiresAt });
		await service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z'));
		expect(sessionUpdateMany).not.toHaveBeenCalled();
	});

	it('automatically gives an existing system owner every declared platform permission', async () => {
		sessionFindUnique.mockResolvedValue(createSession([], 'platform.owner', true));
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).resolves.toMatchObject({
			roles: ['platform.owner'],
			permissions: Object.values(PLATFORM_PERMISSION),
		});
	});

	it('does not grant superadmin access to a non-system owner lookalike', async () => {
		sessionFindUnique.mockResolvedValue(createSession([], 'platform.owner', false));
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).rejects.toMatchObject({ status: 401 });
	});

	it('still rejects a suspended system owner despite its automatic permissions', async () => {
		const owner = createSession([], 'platform.owner', true);
		sessionFindUnique.mockResolvedValue({
			...owner,
			platformStaff: { ...owner.platformStaff, status: PlatformStaffStatus.SUSPENDED },
		});
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).rejects.toMatchObject({ status: 401 });
	});

	it('rechecks owner-role revocation on the next request', async () => {
		sessionFindUnique.mockResolvedValueOnce(createSession([], 'platform.owner', true));
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).resolves.toMatchObject({ permissions: Object.values(PLATFORM_PERMISSION) });
		sessionFindUnique.mockResolvedValueOnce(createSession([]));
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).rejects.toMatchObject({ status: 401 });
	});

	it('fails closed before session reads when transaction acquisition fails', async () => {
		runTransaction.mockRejectedValueOnce(new Error('fictional transaction acquisition failure'));

		await expect(
			service.authenticate('fictional-session-token-with-more-than-32-characters'),
		).rejects.toThrow('fictional transaction acquisition failure');
		expect(sessionFindUnique).not.toHaveBeenCalled();
		expect(sessionUpdateMany).not.toHaveBeenCalled();
	});

	it('retries one rolled-back serialization conflict and revalidates live permissions', async () => {
		runTransaction.mockRejectedValueOnce({ code: 'P2034' });
		sessionFindUnique.mockResolvedValue(
			createSession([{ platformPermission: { key: 'platform.dashboard.read' } }]),
		);
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).resolves.toMatchObject({ permissions: ['platform.dashboard.read'] });
		expect(runTransaction).toHaveBeenCalledTimes(2);
	});

	it('bounds serialization retries and returns an outage rather than logging out the user', async () => {
		runTransaction
			.mockRejectedValueOnce({ code: 'P2034' })
			.mockRejectedValueOnce({ code: 'P2034' })
			.mockRejectedValueOnce({ code: 'P2034' });
		await expect(service.authenticate('fictional-session-token')).rejects.toMatchObject({
			status: 503,
		});
		expect(runTransaction).toHaveBeenCalledTimes(3);
		expect(sessionUpdateMany).not.toHaveBeenCalled();
	});

	it('revalidates permissions after two rolled-back conflicts', async () => {
		runTransaction
			.mockRejectedValueOnce({ code: 'P2034' })
			.mockRejectedValueOnce({ code: 'P2034' });
		sessionFindUnique.mockResolvedValue(createSession([]));
		await expect(
			service.authenticate('fictional-session-token', new Date('2030-01-01T00:10:00.000Z')),
		).rejects.toMatchObject({ status: 401 });
		expect(runTransaction).toHaveBeenCalledTimes(3);
	});

	it('stops retrying when the authentication budget is exhausted', async () => {
		const clock = jest
			.spyOn(performance, 'now')
			.mockReturnValue(19_000)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0);
		runTransaction.mockRejectedValueOnce({ code: 'P2034' });
		try {
			await expect(service.authenticate('fictional-session-token')).rejects.toMatchObject({
				status: 503,
			});
			expect(runTransaction).toHaveBeenCalledTimes(1);
			expect(sessionUpdateMany).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it('rejects idle expiry that passes while waiting to retry', async () => {
		const clock = jest
			.spyOn(performance, 'now')
			.mockReturnValue(10_000)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0);
		runTransaction.mockRejectedValueOnce({ code: 'P2034' });
		sessionFindUnique.mockResolvedValue(
			createSession([{ platformPermission: { key: 'platform.dashboard.read' } }]),
		);
		try {
			await expect(
				service.authenticate('fictional-session-token', new Date('2030-01-01T00:29:59.900Z')),
			).rejects.toMatchObject({ status: 401 });
			expect(runTransaction).toHaveBeenCalledTimes(2);
			expect(sessionUpdateMany).toHaveBeenCalledWith({
				where: { id: 'session-id', revokedAt: null },
				data: { revokedAt: new Date('2030-01-01T00:30:09.900Z'), revocationReason: 'expired' },
			});
		} finally {
			clock.mockRestore();
		}
	});

	it('does not blindly retry an uncertain transaction timeout', async () => {
		runTransaction.mockRejectedValueOnce({
			code: 'P2028',
			message: 'private provider diagnostics',
		});
		await expect(service.authenticate('fictional-session-token')).rejects.toMatchObject({
			status: 503,
		});
		expect(runTransaction).toHaveBeenCalledTimes(1);
		expect(sessionFindUnique).not.toHaveBeenCalled();
	});

	it('revokes a session after all explicit permissions are removed', async () => {
		sessionFindUnique.mockResolvedValue(createSession([]));

		await expect(
			service.authenticate(
				'fictional-session-token-with-more-than-32-characters',
				new Date('2030-01-01T00:10:00.000Z'),
			),
		).rejects.toMatchObject({ status: 401 });
		expect(sessionUpdateMany).toHaveBeenCalledWith({
			where: { id: 'session-id', revokedAt: null },
			data: { revokedAt: new Date('2030-01-01T00:10:00.000Z'), revocationReason: 'invalidated' },
		});
	});

	it('audits one actual logout when conditional revocation races', async () => {
		sessionFindUnique.mockResolvedValue(createSession([], 'platform.owner', true));
		sessionUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
		const token = 'fictional-session-token-with-more-than-32-characters';
		await Promise.all([service.revoke(token), service.revoke(token)]);
		expect(auditCreate).toHaveBeenCalledTimes(1);
		expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { userId: 'user-id', actorKind: 'authentication', action: 'platform_session_revoked' },
		});
	});

	it('does not report logout success if the transactional audit fails', async () => {
		sessionFindUnique.mockResolvedValue(createSession([], 'platform.owner', true));
		auditCreate.mockRejectedValueOnce(new Error('synthetic audit failure'));
		await expect(
			service.revoke('fictional-session-token-with-more-than-32-characters'),
		).rejects.toMatchObject({ status: 503, response: { code: 'PLATFORM_SESSION_UNAVAILABLE' } });
	});
});

function createSession(
	permissions: { readonly platformPermission: { readonly key: string } }[],
	roleKey = 'platform.operator',
	isSystem = false,
) {
	return {
		id: 'session-id',
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
		expiresAt: new Date('2030-01-01T08:00:00.000Z'),
		idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
		revokedAt: null,
		mfaVerifiedAt: new Date('2030-01-01T00:00:00.000Z'),
		platformStaff: {
			id: 'staff-id',
			status: PlatformStaffStatus.ACTIVE,
			user: {
				id: 'user-id',
				identityVersion: 1,
				email: 'admin@example.com',
				displayName: 'Akiba Administrator',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date('2029-01-01T00:00:00.000Z'),
				passwordCredential: {
					passwordChangedAt: new Date('2029-01-01T00:00:00.000Z'),
					disabledAt: null,
				},
			},
			roles: [
				{
					platformRole: {
						key: roleKey,
						isSystem,
						permissions,
					},
				},
			],
		},
	};
}
