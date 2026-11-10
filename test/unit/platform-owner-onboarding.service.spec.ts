import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	OrganizationOwnerInvitationStatus,
	OrganizationStatus,
	PrismaService,
} from '@nexcoderw/akiba-db';

import {
	PlatformOwnerInvitationAudit,
	UnavailableOwnerInvitationAudit,
} from '../../src/modules/platform/owner-onboarding/platform-owner-invitation-audit.js';
import { PlatformOwnerOnboardingService } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.service.js';
import {
	createPlatformOwnerOnboardingDatabaseFixture,
	OWNER_INVITATION_ACTOR_ID,
	OWNER_INVITATION_ID,
	ownerInvitationFixture,
} from '../fixtures/platform-owner-onboarding-database.fixture.js';
import {
	organizationFixture,
	ORGANIZATION_ID,
} from '../fixtures/platform-organizations-database.fixture.js';

import type { PlatformPrincipal } from '../../src/modules/platform/auth/platform-auth.types.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformServiceAuthModule } from '../fixtures/platform-service-auth.module.js';

describe('owner onboarding service contracts (adapter fake, not PostgreSQL)', () => {
	let module: TestingModule;
	let principal: PlatformPrincipal;
	let database: ReturnType<typeof createPlatformOwnerOnboardingDatabaseFixture>;
	let service: PlatformOwnerOnboardingService;
	const assertAvailable = jest.fn<() => void>();
	const record = jest.fn<PlatformOwnerInvitationAudit['record']>();
	const context = {
		actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
		requestId: 'fictional-owner-invitation-request',
	};

	beforeEach(async () => {
		database = createPlatformOwnerOnboardingDatabaseFixture();
		assertAvailable.mockReset();
		record.mockReset().mockResolvedValue(undefined);
		module = await Test.createTestingModule({
			imports: [PlatformServiceAuthModule],
			providers: [
				PlatformOwnerOnboardingService,
				{ provide: PrismaService, useValue: database.prisma },
				{
					provide: PlatformOwnerInvitationAudit,
					useValue: { assertAvailable, record },
				},
			],
		}).compile();
		principal = await module.get(PlatformSessionService).authenticate(
			'fictional-service-session-with-at-least-32-characters',
		);
		service = module.get(PlatformOwnerOnboardingService);
	});
	afterEach(async () => module.close());

	it('denies internal invitation reads and writes with copied or absent authority', async () => {
		for (const identity of [undefined, { ...principal }]) {
			await expect(service.list(identity, ORGANIZATION_ID, { limit: 20 })).rejects.toMatchObject({ status: 403 });
			await expect(service.create(context, identity, ORGANIZATION_ID, {
				displayName: 'Fictional Owner', email: 'owner@example.invalid',
			})).rejects.toMatchObject({ status: 403 });
			await expect(service.revoke(context, identity, ORGANIZATION_ID, OWNER_INVITATION_ID))
				.rejects.toMatchObject({ status: 403 });
		}
		expect(database.runTransaction).not.toHaveBeenCalled();
	});

	it('creates only pending-delivery invitation data and its audit in one transaction', async () => {
		const response = await service.create(context, principal, ORGANIZATION_ID, {
			displayName: 'Aline Uwase',
			email: 'aline@example.com',
		});
		expect(database.invitationCreate.mock.calls[0]?.[0]).toMatchObject({
			data: {
				organizationId: ORGANIZATION_ID,
				invitedByPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
				status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
				tokenDigest: null,
				expiresAt: null,
				sentAt: null,
				acceptedAt: null,
				revokedAt: null,
			},
		});
		expect(record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				...context,
				action: 'created',
				organizationId: ORGANIZATION_ID,
				invitationId: OWNER_INVITATION_ID,
				previousStatus: null,
				resultingStatus: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			}),
		);
		expect(response).not.toHaveProperty('tokenDigest');
		expect(response).not.toHaveProperty('invitedByPlatformStaffId');
		expect(database.userCreate).not.toHaveBeenCalled();
		expect(database.membershipCreate).not.toHaveBeenCalled();
		expect(database.membershipRoleCreate).not.toHaveBeenCalled();
	});

	it.each([OrganizationStatus.SUSPENDED, OrganizationStatus.ARCHIVED])(
		'rejects creation for a %s organization before invitation persistence',
		async (status) => {
			database.findUnique.mockResolvedValue({ ...organizationFixture(), status });
			await expect(
				service.create(context, principal, ORGANIZATION_ID, {
					displayName: 'Aline Uwase',
					email: 'aline@example.com',
				}),
			).rejects.toMatchObject({ status: 409 });
			expect(database.invitationCreate).not.toHaveBeenCalled();
			expect(record).not.toHaveBeenCalled();
		},
	);

	it('maps duplicate outstanding invitations to a deterministic conflict', async () => {
		database.invitationCreate.mockRejectedValueOnce({ code: 'P2002' });
		await expect(
			service.create(context, principal, ORGANIZATION_ID, {
				displayName: 'Aline Uwase',
				email: 'aline@example.com',
			}),
		).rejects.toMatchObject({
			status: 409,
			response: { code: 'OWNER_INVITATION_OUTSTANDING_CONFLICT' },
		});
		expect(record).not.toHaveBeenCalled();
	});

	it('preserves one success and one conflict for simultaneous duplicate creation', async () => {
		database.invitationCreate
			.mockResolvedValueOnce(ownerInvitationFixture())
			.mockRejectedValueOnce({ code: 'P2002' });
		const results = await Promise.allSettled([
			service.create(context, principal, ORGANIZATION_ID, {
				displayName: 'Aline Uwase',
				email: 'aline@example.com',
			}),
			service.create(context, principal, ORGANIZATION_ID, {
				displayName: 'Aline Uwase',
				email: 'aline@example.com',
			}),
		]);
		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: { status: 409 },
		});
		expect(record).toHaveBeenCalledTimes(1);
	});

	it('bounds and scopes list pagination while retaining deterministic ordering', async () => {
		const second = { ...ownerInvitationFixture(), id: '77777777-7777-4777-8777-777777777777' };
		database.invitationFindMany.mockResolvedValue([ownerInvitationFixture(), second]);
		const result = await service.list(principal, ORGANIZATION_ID, {
			limit: 1,
			status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			cursor: OWNER_INVITATION_ID,
		});
		expect(result.nextCursor).toBe(OWNER_INVITATION_ID);
		expect(database.invitationFindFirst.mock.calls[0]?.[0]).toMatchObject({
			where: {
				id: OWNER_INVITATION_ID,
				organizationId: ORGANIZATION_ID,
				status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			},
		});
		expect(database.invitationFindMany.mock.calls[0]?.[0]).toMatchObject({
			take: 2,
			skip: 1,
			cursor: { id: OWNER_INVITATION_ID },
			orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
		});
	});

	it('rejects an out-of-scope cursor and an oversized page before returning data', async () => {
		database.invitationFindFirst.mockResolvedValue(null);
		await expect(
			service.list(principal, ORGANIZATION_ID, { limit: 20, cursor: OWNER_INVITATION_ID }),
		).rejects.toMatchObject({ status: 400 });
		await expect(service.list(principal, ORGANIZATION_ID, { limit: 51 })).rejects.toMatchObject({
			status: 400,
		});
	});

	it.each([
		OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
		OrganizationOwnerInvitationStatus.SENT,
	])('revokes %s atomically and clears future token material', async (status) => {
		const previous = ownerInvitationFixture(status);
		const revoked = {
			...previous,
			status: OrganizationOwnerInvitationStatus.REVOKED,
			revokedAt: new Date(),
		};
		database.invitationFindFirst.mockResolvedValueOnce(previous).mockResolvedValueOnce(revoked);
		await expect(
			service.revoke(context, principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
		).resolves.toMatchObject({ status: OrganizationOwnerInvitationStatus.REVOKED });
		expect(database.invitationUpdateMany.mock.calls[0]?.[0]).toMatchObject({
			where: { id: OWNER_INVITATION_ID, organizationId: ORGANIZATION_ID, status },
			data: { status: OrganizationOwnerInvitationStatus.REVOKED, tokenDigest: null },
		});
		expect(record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: 'revoked',
				previousStatus: status,
				resultingStatus: OrganizationOwnerInvitationStatus.REVOKED,
			}),
		);
	});

	it.each([OrganizationOwnerInvitationStatus.ACCEPTED, OrganizationOwnerInvitationStatus.REVOKED])(
		'returns conflict when revoking terminal state %s',
		async (status) => {
			database.invitationFindFirst.mockResolvedValue(ownerInvitationFixture(status));
			await expect(
				service.revoke(context, principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
			).rejects.toMatchObject({ status: 409 });
			expect(database.invitationUpdateMany).not.toHaveBeenCalled();
			expect(record).not.toHaveBeenCalled();
		},
	);

	it('fails closed for cross-organization identifiers, concurrent updates and audit failure', async () => {
		database.invitationFindFirst.mockResolvedValueOnce(null);
		await expect(
			service.revoke(context, principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
		).rejects.toMatchObject({ status: 404 });
		database.invitationFindFirst.mockResolvedValue(ownerInvitationFixture());
		database.invitationUpdateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			service.revoke(context, principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
		).rejects.toMatchObject({ status: 409 });
		record.mockRejectedValueOnce(new Error('private audit failure'));
		await expect(
			service.revoke(context, principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
		).rejects.toMatchObject({ status: 503 });
	});

	it('does not start a write when durable audit persistence is unavailable', async () => {
		const unavailable = new UnavailableOwnerInvitationAudit();
		assertAvailable.mockImplementation(() => {
			unavailable.assertAvailable();
		});
		await expect(
			service.create(context, principal, ORGANIZATION_ID, {
				displayName: 'Aline Uwase',
				email: 'aline@example.com',
			}),
		).rejects.toMatchObject({ status: 503 });
		expect(database.runTransaction).not.toHaveBeenCalled();
	});
});
