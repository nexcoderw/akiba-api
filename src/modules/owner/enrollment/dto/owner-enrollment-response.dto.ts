import { ApiProperty } from '@nestjs/swagger';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

export class OwnerEnrollmentChallengeResponseDto {
	@ApiProperty({ enum: ['sign_in', 'register'] })
	nextStep!: 'sign_in' | 'register';

	@ApiProperty({ writeOnly: true })
	challengeToken!: string;

	@ApiProperty({ format: 'date-time' })
	expiresAt!: string;

	@ApiProperty({ example: 'Kigali Strength Club' })
	organizationName!: string;

	@ApiProperty({ enum: OrganizationStatus })
	organizationStatus!: OrganizationStatus;
}

export class OwnerEnrollmentAuthenticatedResponseDto {
	@ApiProperty({ enum: ['verified'], example: 'verified' })
	status!: 'verified';

	@ApiProperty({ format: 'date-time' })
	expiresAt!: string;

	@ApiProperty()
	csrfToken!: string;
}

export class OwnerInvitationAcceptedResponseDto {
	@ApiProperty({ enum: ['accepted'], example: 'accepted' })
	status!: 'accepted';

	@ApiProperty({ format: 'uuid' })
	organizationId!: string;

	@ApiProperty({ example: 'Kigali Strength Club' })
	organizationName!: string;

	@ApiProperty({ example: 'kigali-trading' })
	organizationSlug!: string;

	@ApiProperty({ enum: OrganizationStatus })
	organizationStatus!: OrganizationStatus;

	@ApiProperty({ format: 'uuid' })
	membershipId!: string;
}
