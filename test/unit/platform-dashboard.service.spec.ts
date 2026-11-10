import { Test, type TestingModule } from '@nestjs/testing';
import { PlatformStaffStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import { PlatformDashboardService } from '../../src/modules/platform/dashboard/platform-dashboard.service.js';
import { createPlatformDashboardDatabaseFixture } from '../fixtures/platform-dashboard-database.fixture.js';

import type { PlatformPrincipal } from '../../src/modules/platform/auth/platform-auth.types.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformServiceAuthModule } from '../fixtures/platform-service-auth.module.js';

describe('PlatformDashboardService', () => {
	let module: TestingModule;
	let principal: PlatformPrincipal;
	let service: PlatformDashboardService;
	let database: ReturnType<typeof createPlatformDashboardDatabaseFixture>;

	beforeEach(async () => {
		database = createPlatformDashboardDatabaseFixture();
		module = await Test.createTestingModule({
			imports: [PlatformServiceAuthModule],
			providers: [PlatformDashboardService, { provide: PrismaService, useValue: database.prisma }],
		}).compile();
		principal = await module.get(PlatformSessionService).authenticate(
			'fictional-service-session-with-at-least-32-characters',
		);
		service = module.get(PlatformDashboardService);
	});

	afterEach(async () => {
		await module.close();
	});

	it('denies internal calls without the issued platform identity before aggregates', async () => {
		await expect(service.getSummary(undefined)).rejects.toMatchObject({ status: 403 });
		await expect(service.getSummary({ ...principal })).rejects.toMatchObject({ status: 403 });
		expect(database.userCount).not.toHaveBeenCalled();
		expect(database.runTransaction).not.toHaveBeenCalled();
	});

	it('maps every supported aggregate into the exact public response', async () => {
		database.userCount.mockResolvedValue(20);
		database.staffGroupBy.mockResolvedValue([
			{ status: PlatformStaffStatus.PENDING, _count: { _all: 2 } },
			{ status: PlatformStaffStatus.ACTIVE, _count: { _all: 3 } },
			{ status: PlatformStaffStatus.SUSPENDED, _count: { _all: 4 } },
			{ status: PlatformStaffStatus.REVOKED, _count: { _all: 5 } },
		]);
		database.roleCount.mockResolvedValue(6);
		database.permissionCount.mockResolvedValue(7);
		const before = Date.now();
		const result = await service.getSummary(principal);

		expect(result).toEqual({
			generatedAt: result.generatedAt,
			globalUsers: { total: 20 },
			platformStaff: { total: 14, pending: 2, active: 3, suspended: 4, revoked: 5 },
			platformRoles: { total: 6 },
			platformPermissions: { total: 7 },
		});
		expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
		expect(Date.parse(result.generatedAt)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(result.generatedAt)).toBeLessThanOrEqual(Date.now());
	});

	it.each([
		{ status: PlatformStaffStatus.PENDING, field: 'pending' },
		{ status: PlatformStaffStatus.ACTIVE, field: 'active' },
		{ status: PlatformStaffStatus.SUSPENDED, field: 'suspended' },
		{ status: PlatformStaffStatus.REVOKED, field: 'revoked' },
	])('defaults missing statuses to zero when only $status exists', async ({ status, field }) => {
		database.staffGroupBy.mockResolvedValue([{ status, _count: { _all: 3 } }]);
		const result = await service.getSummary(principal);
		expect(result.platformStaff).toEqual({
			total: 3,
			pending: 0,
			active: 0,
			suspended: 0,
			revoked: 0,
			[field]: 3,
		});
	});

	it('returns numeric zeroes for an empty database', async () => {
		expect(await service.getSummary(principal)).toMatchObject({
			globalUsers: { total: 0 },
			platformStaff: { total: 0, pending: 0, active: 0, suspended: 0, revoked: 0 },
			platformRoles: { total: 0 },
			platformPermissions: { total: 0 },
		});
	});

	it('uses four aggregates and one repeatable-read transaction without fetching records', async () => {
		await service.getSummary(principal);
		expect(database.userCount).toHaveBeenCalledTimes(1);
		expect(database.staffGroupBy).toHaveBeenCalledTimes(1);
		expect(database.staffGroupBy).toHaveBeenCalledWith({
			by: ['status'],
			orderBy: { status: 'asc' },
			_count: { _all: true },
		});
		expect(database.roleCount).toHaveBeenCalledTimes(1);
		expect(database.permissionCount).toHaveBeenCalledTimes(1);
		expect(database.runTransaction).toHaveBeenCalledTimes(1);
		expect(database.runTransaction.mock.calls[0]?.[1]).toEqual({
			isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
		});
		expect(database.sessionFindUnique).not.toHaveBeenCalled();
		expect(database.sessionUpdateMany).not.toHaveBeenCalled();
	});

	it('propagates persistence failures instead of returning fabricated zero statistics', async () => {
		const failure = new Error('Fictional database failure');
		database.runTransaction.mockRejectedValueOnce(failure);
		await expect(service.getSummary(principal)).rejects.toBe(failure);
	});
});
