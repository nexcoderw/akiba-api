import { Transform } from 'class-transformer';
import { IsNotIn, IsString, Matches, MaxLength, MinLength, NotContains } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { ORGANIZATION_RESERVED_SLUGS } from '../platform-organizations.constants.js';

export class CreateOrganizationDto {
	@ApiProperty({ example: 'Kimihurura Supplies', minLength: 1, maxLength: 160 })
	@Transform(({ value }: { value: unknown }) =>
		typeof value === 'string' ? value.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '') : value,
	)
	@IsString()
	@MinLength(1)
	@MaxLength(160)
	@NotContains('\u0000')
	@Matches(/[^\s\u0085]/u, { message: 'name must contain meaningful text' })
	name!: string;

	@ApiProperty({ example: 'kimihurura', minLength: 3, maxLength: 63 })
	@IsString()
	@MinLength(3)
	@MaxLength(63)
	// The absolute-end assertion also rejects a final newline (JavaScript's $ can accept it).
	@Matches(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/u)
	@IsNotIn(ORGANIZATION_RESERVED_SLUGS)
	slug!: string;
}
