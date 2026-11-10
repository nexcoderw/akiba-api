import { ApiProperty } from '@nestjs/swagger';

export class PlatformDashboardCountDto {
	@ApiProperty({ type: 'integer', minimum: 0, example: 1 })
	total!: number;
}

export class PlatformDashboardStaffDto extends PlatformDashboardCountDto {
	@ApiProperty({ type: 'integer', minimum: 0, example: 0 })
	pending!: number;

	@ApiProperty({ type: 'integer', minimum: 0, example: 1 })
	active!: number;

	@ApiProperty({ type: 'integer', minimum: 0, example: 0 })
	suspended!: number;

	@ApiProperty({ type: 'integer', minimum: 0, example: 0 })
	revoked!: number;
}

/** Aggregate-only platform contract; never includes identity or authentication records. */
export class PlatformDashboardSummaryDto {
	@ApiProperty({
		format: 'date-time',
		example: '2026-10-13T08:00:00.000Z',
		description: 'UTC response generation time after the consistent database snapshot was read.',
	})
	generatedAt!: string;

	@ApiProperty({
		type: PlatformDashboardCountDto,
		description:
			'All global identity accounts, regardless of status; these are not organization members.',
	})
	globalUsers!: PlatformDashboardCountDto;

	@ApiProperty({
		type: PlatformDashboardStaffDto,
		description:
			'Assignment status counts, not logged-in or fully authorized administrator counts.',
	})
	platformStaff!: PlatformDashboardStaffDto;

	@ApiProperty({ type: PlatformDashboardCountDto, description: 'All registered platform roles.' })
	platformRoles!: PlatformDashboardCountDto;

	@ApiProperty({
		type: PlatformDashboardCountDto,
		description: 'All registered platform permissions, including unassigned permissions.',
	})
	platformPermissions!: PlatformDashboardCountDto;
}
