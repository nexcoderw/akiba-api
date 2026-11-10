import { ApiProperty } from '@nestjs/swagger';
import { OrganizationOwnerInvitationDeliveryStatus } from '@nexcoderw/akiba-db';
import { IsString, Matches, MaxLength } from 'class-validator';

export class OwnerInvitationDeliveryResponseDto {
	@ApiProperty({ enum: OrganizationOwnerInvitationDeliveryStatus })
	status!: OrganizationOwnerInvitationDeliveryStatus;

	@ApiProperty({ example: 'Invitation delivery has been queued.' })
	message!: string;
}

export class OwnerInvitationPreviewDto {
	@ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
	@IsString()
	@MaxLength(43)
	@Matches(/^[A-Za-z0-9_-]{43}$/u)
	token!: string;
}

export class OwnerInvitationPreviewResponseDto {
	@ApiProperty({ example: true, enum: [true] })
	valid!: true;

	@ApiProperty({ example: 'Kimihurura Supplies', maxLength: 160 })
	organizationName!: string;
}
