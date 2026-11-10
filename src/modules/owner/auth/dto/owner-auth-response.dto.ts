import { ApiProperty } from '@nestjs/swagger';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

export class OwnerOrganizationAccessDto {
	@ApiProperty({ format: 'uuid' })
	organizationId!: string;

	@ApiProperty({ example: 'Kigali Strength Club' })
	name!: string;

	@ApiProperty({ example: 'kigali-trading' })
	slug!: string;

	@ApiProperty({ enum: OrganizationStatus })
	status!: OrganizationStatus;

	@ApiProperty({ format: 'uuid' })
	membershipId!: string;

	@ApiProperty({ example: ['owner'], isArray: true })
	roles!: string[];
}

export class OwnerAuthenticatedResponseDto {
	@ApiProperty({ enum: ['authenticated'], example: 'authenticated' })
	status!: 'authenticated';

	@ApiProperty({ format: 'date-time' })
	expiresAt!: string;

	@ApiProperty({ example: 'opaque-csrf-token' })
	csrfToken!: string;
}

export class OwnerSessionResponseDto {
	@ApiProperty({ format: 'uuid' })
	userId!: string;

	@ApiProperty({ example: 'Aline Uwase' })
	displayName!: string;

	@ApiProperty({ example: 'aline@example.com' })
	email!: string;

	@ApiProperty({ enum: ['aal1', 'aal2'] })
	assurance!: 'aal1' | 'aal2';

	@ApiProperty({ format: 'date-time' })
	expiresAt!: string;

	@ApiProperty({ type: [OwnerOrganizationAccessDto] })
	organizations!: OwnerOrganizationAccessDto[];
}
