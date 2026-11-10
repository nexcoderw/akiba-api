import { jest } from '@jest/globals';
import type { PlatformStaffStatus } from '@nexcoderw/akiba-db';

export interface StaffStatusAggregate {
	readonly status: PlatformStaffStatus;
	readonly _count: { readonly _all: number };
}

/** Adapter-boundary fake only; this fixture never opens a PostgreSQL connection. */
export function createPlatformDashboardDatabaseFixture() {
	const userCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);
	const staffGroupBy = jest.fn<() => Promise<StaffStatusAggregate[]>>().mockResolvedValue([]);
	const roleCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);
	const permissionCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);
	const sessionFindUnique = jest.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue(null);
	const sessionUpdateMany = jest
		.fn<(args: unknown) => Promise<{ count: number }>>()
		.mockResolvedValue({ count: 1 });
	const client = {
		platformAdminSession: { findUnique: sessionFindUnique, updateMany: sessionUpdateMany },
	};
	type Operation = Promise<unknown>[] | ((transaction: typeof client) => Promise<unknown>);
	const runTransaction = jest
		.fn<(operation: Operation, options?: unknown) => Promise<unknown>>()
		.mockImplementation((operation) =>
			Array.isArray(operation) ? Promise.all(operation) : operation(client),
		);

	return {
		userCount,
		staffGroupBy,
		roleCount,
		permissionCount,
		sessionFindUnique,
		sessionUpdateMany,
		runTransaction,
		prisma: {
			user: { count: userCount },
			platformStaff: { groupBy: staffGroupBy },
			platformRole: { count: roleCount },
			platformPermission: { count: permissionCount },
			platformAdminSession: client.platformAdminSession,
			$transaction: runTransaction,
		},
	};
}
