import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

export class ListOrganizationsQueryDto {
	@ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
	@Transform(({ value }: { value: unknown }) =>
		typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value,
	)
	@IsInt()
	@Min(1)
	@Max(50)
	limit = 20;

	@ApiPropertyOptional({ enum: OrganizationStatus })
	@IsOptional()
	@IsEnum(OrganizationStatus)
	status?: OrganizationStatus;

	@ApiPropertyOptional({
		format: 'uuid',
		description: 'Last emitted organization UUID; keep the same status filter.',
	})
	@IsOptional()
	@IsUUID()
	cursor?: string;
}
