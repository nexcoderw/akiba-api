import { Test, type TestingModule } from '@nestjs/testing';
import { PlatformStaffStatus, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { AppModule } from '../../src/app.module.js';
import { PlatformPermissionGuard } from '../../src/modules/platform/auth/platform-permission.guard.js';
import { PlatformSessionGuard } from '../../src/modules/platform/auth/platform-session.guard.js';
import { PlatformDashboardController } from '../../src/modules/platform/dashboard/platform-dashboard.controller.js';
import { PlatformDashboardService } from '../../src/modules/platform/dashboard/platform-dashboard.service.js';
import { createPlatformDashboardDatabaseFixture } from '../fixtures/platform-dashboard-database.fixture.js';

describe('PlatformDashboardModule adapter integration (no PostgreSQL)', () => {
	let module: TestingModule;
	const database = createPlatformDashboardDatabaseFixture();

	beforeAll(async () => {
		module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue(database.prisma)
			.compile();
	});

	afterAll(async () => {
		await module.close();
	});

	it('resolves the controller, service, existing guards, and shared database provider', () => {
		expect(module.get(PlatformDashboardController)).toBeInstanceOf(PlatformDashboardController);
		expect(module.get(PlatformDashboardService)).toBeInstanceOf(PlatformDashboardService);
		expect(module.get(PlatformSessionGuard)).toBeInstanceOf(PlatformSessionGuard);
		expect(module.get(PlatformPermissionGuard)).toBeInstanceOf(PlatformPermissionGuard);
		expect(module.get(PrismaService)).toBe(database.prisma);
	});

	it('counts global identities and assignment statuses independently without modifying records', async () => {
		const users = [
			{ email: 'operator@example.invalid', status: UserStatus.ACTIVE },
			{ email: 'suspended@example.invalid', status: UserStatus.SUSPENDED },
			{ email: 'pending@example.invalid', status: UserStatus.PENDING },
			{ email: 'unassigned@example.invalid', status: UserStatus.ACTIVE },
		];
		const staff = [
			{ userEmail: users[0]?.email, status: PlatformStaffStatus.ACTIVE },
			{ userEmail: users[1]?.email, status: PlatformStaffStatus.ACTIVE },
			{ userEmail: users[2]?.email, status: PlatformStaffStatus.PENDING },
		];
		const before = JSON.stringify({ users, staff });
		database.userCount.mockResolvedValue(users.length);
		database.staffGroupBy.mockResolvedValue(
			Object.values(PlatformStaffStatus).flatMap((status) => {
				const count = staff.filter((assignment) => assignment.status === status).length;
				return count === 0 ? [] : [{ status, _count: { _all: count } }];
			}),
		);
		database.roleCount.mockResolvedValue(2);
		database.permissionCount.mockResolvedValue(3);

		expect(await module.get(PlatformDashboardController).getSummary()).toMatchObject({
			globalUsers: { total: 4 },
			platformStaff: { total: 3, active: 2, pending: 1, suspended: 0, revoked: 0 },
			platformRoles: { total: 2 },
			platformPermissions: { total: 3 },
		});
		expect(JSON.stringify({ users, staff })).toBe(before);
		expect(database.sessionUpdateMany).not.toHaveBeenCalled();
	});

	it('maps an empty adapter result through the registered controller', async () => {
		database.userCount.mockResolvedValue(0);
		database.staffGroupBy.mockResolvedValue([]);
		database.roleCount.mockResolvedValue(0);
		database.permissionCount.mockResolvedValue(0);
		expect(await module.get(PlatformDashboardController).getSummary()).toMatchObject({
			globalUsers: { total: 0 },
			platformStaff: { total: 0, active: 0, pending: 0, suspended: 0, revoked: 0 },
			platformRoles: { total: 0 },
			platformPermissions: { total: 0 },
		});
	});
});
