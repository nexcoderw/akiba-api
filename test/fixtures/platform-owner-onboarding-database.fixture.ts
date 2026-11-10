import { jest } from '@jest/globals';
import {
	OrganizationOwnerInvitationStatus,
	type OrganizationOwnerInvitation,
} from '@nexcoderw/akiba-db';

import {
	createPlatformOrganizationsDatabaseFixture,
	ORGANIZATION_ID,
	ORGANIZATION_TIME,
} from './platform-organizations-database.fixture.js';

export const OWNER_INVITATION_ID = '55555555-5555-4555-8555-555555555555';
export const OWNER_INVITATION_ACTOR_ID = '33333333-3333-4333-8333-333333333333';

export function ownerInvitationFixture(
	status: OrganizationOwnerInvitation['status'] = OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
): OrganizationOwnerInvitation {
	return {
		id: OWNER_INVITATION_ID,
		organizationId: ORGANIZATION_ID,
		invitedEmail: 'aline@example.com',
		invitedDisplayName: 'Aline Uwase',
		invitedByPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
		status,
		tokenDigest: null,
		expiresAt: null,
		sentAt: status === OrganizationOwnerInvitationStatus.SENT ? ORGANIZATION_TIME : null,
		acceptedAt: status === OrganizationOwnerInvitationStatus.ACCEPTED ? ORGANIZATION_TIME : null,
		revokedAt: status === OrganizationOwnerInvitationStatus.REVOKED ? ORGANIZATION_TIME : null,
		createdAt: ORGANIZATION_TIME,
		updatedAt: ORGANIZATION_TIME,
	};
}

/** Adapter-boundary fake; live PostgreSQL tests remain the database-contract authority. */
export function createPlatformOwnerOnboardingDatabaseFixture() {
	const base = createPlatformOrganizationsDatabaseFixture();
	const invitationFindFirst = jest
		.fn<(args: unknown) => Promise<OrganizationOwnerInvitation | { id: string } | null>>()
		.mockResolvedValue(ownerInvitationFixture());
	const invitationFindMany = jest
		.fn<(args: unknown) => Promise<OrganizationOwnerInvitation[]>>()
		.mockResolvedValue([ownerInvitationFixture()]);
	const invitationCreate = jest
		.fn<(args: unknown) => Promise<OrganizationOwnerInvitation>>()
		.mockResolvedValue(ownerInvitationFixture());
	const invitationUpdateMany = jest
		.fn<(args: unknown) => Promise<{ count: number }>>()
		.mockResolvedValue({ count: 1 });
	const ownershipAuditCreate = jest
		.fn<(args: unknown) => Promise<{ id: string }>>()
		.mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' });
	const userCreate = jest.fn();
	const membershipCreate = jest.fn();
	const membershipRoleCreate = jest.fn();
	const client = {
		...base.prisma,
		user: { ...base.prisma.user, create: userCreate },
		organizationMembership: { create: membershipCreate },
		organizationMembershipRole: { create: membershipRoleCreate },
		organizationOwnerInvitation: {
			findFirst: invitationFindFirst,
			findMany: invitationFindMany,
			create: invitationCreate,
			updateMany: invitationUpdateMany,
		},
		organizationOwnershipAuditEvent: { create: ownershipAuditCreate },
	};
	type Operation = Promise<unknown>[] | ((transaction: typeof client) => Promise<unknown>);
	const runTransaction = jest
		.fn<(operation: Operation, options?: unknown) => Promise<unknown>>()
		.mockImplementation((operation) =>
			Array.isArray(operation) ? Promise.all(operation) : operation(client),
		);

	return {
		...base,
		invitationFindFirst,
		invitationFindMany,
		invitationCreate,
		invitationUpdateMany,
		ownershipAuditCreate,
		userCreate,
		membershipCreate,
		membershipRoleCreate,
		runTransaction,
		prisma: { ...client, $transaction: runTransaction },
	};
}
