import { ApiProperty } from '@nestjs/swagger';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

export class OrganizationResponseDto {
	@ApiProperty({ format: 'uuid' })
	id!: string;

	@ApiProperty({ example: 'Kimihurura Supplies', maxLength: 160 })
	name!: string;

	@ApiProperty({ example: 'kimihurura', minLength: 3, maxLength: 63 })
	slug!: string;

	@ApiProperty({ enum: OrganizationStatus })
	status!: OrganizationStatus;

	@ApiProperty({ format: 'date-time' })
	createdAt!: string;

	@ApiProperty({ format: 'date-time' })
	updatedAt!: string;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	activatedAt!: string | null;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	suspendedAt!: string | null;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	archivedAt!: string | null;
}
