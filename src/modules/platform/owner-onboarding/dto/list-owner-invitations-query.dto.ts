import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationOwnerInvitationStatus } from '@nexcoderw/akiba-db';

export class ListOwnerInvitationsQueryDto {
	@ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
	@Transform(({ value }: { value: unknown }) =>
		typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value,
	)
	@IsInt()
	@Min(1)
	@Max(50)
	limit = 20;

	@ApiPropertyOptional({ enum: OrganizationOwnerInvitationStatus })
	@IsOptional()
	@IsEnum(OrganizationOwnerInvitationStatus)
	status?: OrganizationOwnerInvitationStatus;

	@ApiPropertyOptional({
		format: 'uuid',
		description: 'Last emitted invitation UUID; keep the same organization and status filter.',
	})
	@IsOptional()
	@IsUUID()
	cursor?: string;
}
