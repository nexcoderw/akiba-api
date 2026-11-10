import { ApiProperty } from '@nestjs/swagger';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

export class OwnerDashboardResponseDto {
	@ApiProperty({ format: 'uuid' })
	organizationId!: string;

	@ApiProperty({ example: 'Kigali Strength Club' })
	organizationName!: string;

	@ApiProperty({ example: 'kigali-trading' })
	organizationSlug!: string;

	@ApiProperty({ format: 'uuid' })
	membershipId!: string;

	@ApiProperty({ enum: OrganizationStatus })
	organizationStatus!: OrganizationStatus;

	@ApiProperty({ enum: ['available', 'pending_activation'] })
	operationalAccess!: 'available' | 'pending_activation';

	@ApiProperty({ enum: ['owner'], isArray: true, example: ['owner'] })
	roles!: string[];
}
