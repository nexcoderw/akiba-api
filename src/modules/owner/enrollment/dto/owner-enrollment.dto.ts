import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	MinLength,
	NotContains,
	ValidateIf,
} from 'class-validator';

import { MAXIMUM_BOOTSTRAP_PASSWORD_BYTES } from '../../../platform/auth/platform-password-policy.js';

const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const TRIM_PATTERN = /^[\s\u0085]+|[\s\u0085]+$/gu;

export class StartOwnerEnrollmentDto {
	@ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
	@IsString()
	@Matches(OPAQUE_TOKEN)
	invitationToken!: string;
}

export class VerifyExistingOwnerDto {
	@ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
	@IsString()
	@Matches(OPAQUE_TOKEN)
	challengeToken!: string;

	@ApiProperty({ minLength: 1, writeOnly: true, maxLength: MAXIMUM_BOOTSTRAP_PASSWORD_BYTES })
	@IsString()
	@MinLength(1)
	@MaxLength(MAXIMUM_BOOTSTRAP_PASSWORD_BYTES)
	password!: string;
}

export class RegisterInvitedOwnerDto extends VerifyExistingOwnerDto {
	@ApiProperty({
		required: false,
		deprecated: true,
		description: 'Accepted for older clients. The invitation determines the account name.',
	})
	@IsOptional()
	@Transform(({ value }: { value: unknown }) =>
		typeof value === 'string' ? value.replace(TRIM_PATTERN, '') : value,
	)
	@IsString()
	@MinLength(1)
	@MaxLength(160)
	@NotContains('\u0000')
	@Matches(/[^\s\u0085]/u, { message: 'displayName must contain meaningful text' })
	displayName?: string;
}

export class AcceptOwnerInvitationDto {
	@ApiProperty({ required: false, minLength: 43, maxLength: 43, writeOnly: true })
	@ValidateIf(
		(input: AcceptOwnerInvitationDto) =>
			input.emailOtpToken !== undefined || input.code !== undefined,
	)
	@IsString()
	@Matches(OPAQUE_TOKEN)
	emailOtpToken?: string;

	@ApiProperty({ required: false, minLength: 6, maxLength: 6, writeOnly: true })
	@ValidateIf(
		(input: AcceptOwnerInvitationDto) =>
			input.emailOtpToken !== undefined || input.code !== undefined,
	)
	@IsString()
	@Matches(/^\d{6}$/u)
	code?: string;

	@ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
	@IsString()
	@Matches(OPAQUE_TOKEN)
	challengeToken!: string;
}
