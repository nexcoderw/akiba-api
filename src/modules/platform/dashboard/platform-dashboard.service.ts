import { Injectable } from '@nestjs/common';
import { PlatformStaffStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import type { PlatformDashboardSummaryDto } from './dto/platform-dashboard-summary.dto.js';

import { PlatformSessionService } from '../auth/platform-session.service.js';
import type { PlatformPrincipal } from '../auth/platform-auth.types.js';
import { PLATFORM_PERMISSION } from '../auth/platform-permission.constants.js';

@Injectable()
export class PlatformDashboardService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly sessions: PlatformSessionService,
	) {}

	/**
	 * Reads four aggregates from one repeatable-read snapshot on the existing database client.
	 * generatedAt describes response generation, not the exact snapshot acquisition time.
	 * Persistence failures propagate to the centralized safe HTTP exception boundary.
	 */
	async getSummary(principal: PlatformPrincipal | undefined): Promise<PlatformDashboardSummaryDto> {
		await this.sessions.authorize(principal, PLATFORM_PERMISSION.dashboardRead);
		const staffGroupByArgs = {
			by: ['status'],
			orderBy: { status: 'asc' },
			_count: { _all: true },
		} satisfies Prisma.PlatformStaffGroupByArgs;
		// Infer the exact aggregate payload before the transaction's tuple context widens it.
		// Prisma promises are lazy: this query still executes only inside the transaction.
		const staffStatusQuery = this.prisma.platformStaff.groupBy(staffGroupByArgs);
		const [users, staffGroups, roles, permissions] = await this.prisma.$transaction(
			[
				this.prisma.user.count(),
				staffStatusQuery,
				this.prisma.platformRole.count(),
				this.prisma.platformPermission.count(),
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
		);
		const staffCounts: Record<PlatformStaffStatus, number> = {
			[PlatformStaffStatus.PENDING]: 0,
			[PlatformStaffStatus.ACTIVE]: 0,
			[PlatformStaffStatus.SUSPENDED]: 0,
			[PlatformStaffStatus.REVOKED]: 0,
		};
		let staffTotal = 0;
		for (const group of staffGroups) {
			staffCounts[group.status] = group._count._all;
			staffTotal += group._count._all;
		}

		return {
			generatedAt: new Date().toISOString(),
			globalUsers: { total: users },
			platformStaff: {
				total: staffTotal,
				pending: staffCounts[PlatformStaffStatus.PENDING],
				active: staffCounts[PlatformStaffStatus.ACTIVE],
				suspended: staffCounts[PlatformStaffStatus.SUSPENDED],
				revoked: staffCounts[PlatformStaffStatus.REVOKED],
			},
			platformRoles: { total: roles },
			platformPermissions: { total: permissions },
		};
	}
}
