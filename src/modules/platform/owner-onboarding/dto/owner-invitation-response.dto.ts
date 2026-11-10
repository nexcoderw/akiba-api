import { ApiProperty } from '@nestjs/swagger';
import {
	OrganizationOwnerInvitationDeliveryStatus,
	OrganizationOwnerInvitationStatus,
} from '@nexcoderw/akiba-db';

export class OwnerInvitationResponseDto {
	@ApiProperty({ format: 'uuid' })
	id!: string;

	@ApiProperty({ format: 'uuid' })
	organizationId!: string;

	@ApiProperty({ example: 'Aline Uwase', maxLength: 160 })
	displayName!: string;

	@ApiProperty({ example: 'aline@example.com', maxLength: 254 })
	email!: string;

	@ApiProperty({ enum: OrganizationOwnerInvitationStatus })
	status!: OrganizationOwnerInvitationStatus;

	@ApiProperty({ enum: OrganizationOwnerInvitationDeliveryStatus, nullable: true })
	deliveryStatus!: OrganizationOwnerInvitationDeliveryStatus | null;

	@ApiProperty({ format: 'date-time' })
	createdAt!: string;

	@ApiProperty({ format: 'date-time' })
	updatedAt!: string;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	sentAt!: string | null;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	expiresAt!: string | null;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	acceptedAt!: string | null;

	@ApiProperty({ type: String, format: 'date-time', nullable: true })
	revokedAt!: string | null;
}
