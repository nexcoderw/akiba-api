import {
	IsEmailIdentity,
	transformEmailIdentity,
} from '../../../../common/identity/email-identity.js';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { MAXIMUM_BOOTSTRAP_PASSWORD_BYTES } from '../../../platform/auth/platform-password-policy.js';

export class OwnerLoginDto {
	@ApiProperty({ example: 'owner@example.com', maxLength: 254 })
	@Transform(({ value }: { value: unknown }) => transformEmailIdentity(value))
	@IsEmailIdentity()
	@MaxLength(254)
	email!: string;

	@ApiProperty({ minLength: 1, writeOnly: true, maxLength: MAXIMUM_BOOTSTRAP_PASSWORD_BYTES })
	@IsString()
	@MinLength(1)
	@MaxLength(MAXIMUM_BOOTSTRAP_PASSWORD_BYTES)
	password!: string;
}

export class VerifyOwnerEmailOtpDto {
	@ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
	@IsString()
	@Matches(/^[A-Za-z0-9_-]{43}$/u)
	token!: string;

	@ApiProperty({ minLength: 6, maxLength: 6, writeOnly: true })
	@IsString()
	@Matches(/^\d{6}$/u)
	code!: string;
}
