import { jest } from '@jest/globals';
import {
	OrganizationStatus,
	PlatformStaffStatus,
	UserStatus,
	type Organization,
} from '@nexcoderw/akiba-db';

import { createPlatformDashboardDatabaseFixture } from './platform-dashboard-database.fixture.js';

export const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
export const ORGANIZATION_TIME = new Date('2026-10-13T12:00:00.000Z');

export function organizationFixture(): Organization {
	return {
		id: ORGANIZATION_ID,
		name: 'Kimihurura Supplies',
		slug: 'kimihurura',
		status: OrganizationStatus.PENDING,
		createdAt: ORGANIZATION_TIME,
		updatedAt: ORGANIZATION_TIME,
		activatedAt: null,
		suspendedAt: null,
		archivedAt: null,
	};
}

/** Persistence-boundary fake; never evidence of real PostgreSQL constraints or audit durability. */
export function createPlatformOrganizationsDatabaseFixture() {
	const base = createPlatformDashboardDatabaseFixture();
	const findUnique = jest
		.fn<(args: unknown) => Promise<Organization | null>>()
		.mockResolvedValue(organizationFixture());
	const findFirst = jest
		.fn<(args: unknown) => Promise<{ id: string } | null>>()
		.mockResolvedValue({ id: ORGANIZATION_ID });
	const findMany = jest
		.fn<(args: unknown) => Promise<Organization[]>>()
		.mockResolvedValue([organizationFixture()]);
	const create = jest
		.fn<(args: unknown) => Promise<Organization>>()
		.mockResolvedValue(organizationFixture());
	const updateMany = jest
		.fn<(args: unknown) => Promise<{ count: number }>>()
		.mockResolvedValue({ count: 1 });
	const client = {
		organizationAuditEvent: {
			create: jest.fn<(args: unknown) => Promise<{ id: string }>>().mockResolvedValue({
				id: '77777777-7777-4777-8777-777777777777',
			}),
		},
		...base.prisma,
		organization: { findUnique, findFirst, findMany, create, updateMany },
	};
	type Operation = Promise<unknown>[] | ((transaction: typeof client) => Promise<unknown>);
	const runTransaction = jest
		.fn<(operation: Operation, options?: unknown) => Promise<unknown>>()
		.mockImplementation((operation) =>
			Array.isArray(operation) ? Promise.all(operation) : operation(client),
		);
	return {
		...base,
		findUnique,
		findFirst,
		findMany,
		create,
		updateMany,
		auditCreate: client.organizationAuditEvent.create,
		runTransaction,
		prisma: { ...client, $transaction: runTransaction },
	};
}

interface OrganizationSessionFixture {
	id: string;
	createdAt: Date;
	expiresAt: Date;
	idleExpiresAt: Date;
	revokedAt: Date | null;
	mfaVerifiedAt: Date;
	platformStaff: {
		id: string;
		status: PlatformStaffStatus;
		user: {
			id: string;
			email: string;
			displayName: string;
			status: UserStatus;
			emailVerifiedAt: Date | null;
			passwordCredential: { passwordChangedAt: Date; disabledAt: Date | null };
		};
		roles: {
			platformRole: {
				key: string;
				isSystem: boolean;
				permissions: { platformPermission: { key: string } }[];
			};
		}[];
	};
}

export function organizationSessionFixture(
	permissions: readonly string[],
): OrganizationSessionFixture {
	const now = Date.now();
	return {
		id: '22222222-2222-4222-8222-222222222222',
		createdAt: new Date(now - 60_000),
		expiresAt: new Date(now + 3_600_000),
		idleExpiresAt: new Date(now + 1_800_000),
		revokedAt: null,
		mfaVerifiedAt: new Date(now - 60_000),
		platformStaff: {
			id: '33333333-3333-4333-8333-333333333333',
			status: PlatformStaffStatus.ACTIVE,
			user: {
				id: '44444444-4444-4444-8444-444444444444',
				email: 'operator@example.invalid',
				displayName: 'Fictional Operator',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(now - 86_400_000),
				passwordCredential: { passwordChangedAt: new Date(now - 86_400_000), disabledAt: null },
			},
			roles: [
				{
					platformRole: {
						key: 'platform.owner',
						isSystem: false,
						permissions: permissions.map((key) => ({ platformPermission: { key } })),
					},
				},
			],
		},
	};
}
