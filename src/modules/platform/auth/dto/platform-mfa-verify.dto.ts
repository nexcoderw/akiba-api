import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { PlatformMfaMethod } from '../platform-auth.types.js';

export class PlatformMfaVerifyDto {
	@ApiProperty({ enum: ['email_otp', 'totp', 'recovery_code'], example: 'totp' })
	@IsIn(['email_otp', 'totp', 'recovery_code'])
	method!: PlatformMfaMethod;

	@ApiPropertyOptional({
		description: 'Six-digit code delivered to the verified account email.',
		example: '012345',
	})
	@IsOptional()
	@IsString()
	@Matches(/^\d{6}$/u)
	emailOtpCode?: string;

	@ApiPropertyOptional({ description: 'Current six-digit authenticator code.', example: '123456' })
	@IsOptional()
	@IsString()
	@Matches(/^\d{6}$/u)
	totpCode?: string;

	@ApiPropertyOptional({
		description: 'A single-use recovery code. It is never returned by this API.',
		example: 'fictional-recovery-code',
		maxLength: 128,
	})
	@IsOptional()
	@IsString()
	@MinLength(12)
	@MaxLength(128)
	recoveryCode?: string;
}
