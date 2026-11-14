import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export const MFA_OPERATIONS = [
	'totp_enroll',
	'totp_replace',
	'totp_remove',
	'factor_rename',
	'recovery_regenerate',
] as const;
export type MfaOperation = (typeof MFA_OPERATIONS)[number];

export class PlatformStepUpStartDto {
	@ApiProperty({ enum: MFA_OPERATIONS })
	@IsIn(MFA_OPERATIONS)
	operation!: MfaOperation;

	@ApiProperty({
		description: 'Current primary credential; never stored or logged.',
		maxLength: 1024,
	})
	@IsString()
	@MinLength(1)
	@MaxLength(1024)
	password!: string;

	@ApiPropertyOptional({
		description: 'Required only for an operation targeting the current factor.',
	})
	@IsOptional()
	@IsUUID()
	factorId?: string;
}

export class PlatformStepUpVerifyDto {
	@ApiProperty({ enum: ['totp', 'recovery_code'] })
	@IsIn(['totp', 'recovery_code'])
	method!: 'totp' | 'recovery_code';

	@ApiProperty({ description: 'Six-digit TOTP or an unused recovery code.', maxLength: 64 })
	@IsString()
	@MinLength(6)
	@MaxLength(64)
	code!: string;
}

export class PlatformFactorLabelDto {
	@ApiProperty({ example: 'Work Authenticator', maxLength: 80 })
	@IsString()
	@MinLength(1)
	@MaxLength(80)
	label!: string;
}

export class PlatformTotpConfirmDto {
	@ApiProperty({ example: '123456' })
	@IsString()
	@Matches(/^\d{6}$/u)
	code!: string;
}

export class PlatformMfaStateDto {
	@ApiProperty({ example: 'step_up_required' })
	status!: string;

	@ApiPropertyOptional({ example: '2026-11-14T12:05:00.000Z' })
	expiresAt?: string;
}

export class PlatformTotpSetupDto {
	@ApiProperty({ description: 'Authorized one-time setup response. Never cache or log.' })
	secret!: string;

	@ApiProperty({
		description: 'Configure locally in an authenticator. Do not navigate to or log this URI.',
	})
	enrollmentUri!: string;

	@ApiProperty()
	expiresAt!: string;
}

export class PlatformMfaRecoveryCodesDto {
	@ApiProperty({ enum: ['reauthentication_required'] })
	status!: 'reauthentication_required';

	@ApiProperty({
		type: [String],
		description: 'Shown once. Save offline; never log or persist in browser storage.',
	})
	recoveryCodes!: string[];
}

export class PlatformMfaFactorDto {
	@ApiProperty()
	id!: string;

	@ApiProperty({ enum: ['totp'] })
	type!: 'totp';

	@ApiProperty()
	label!: string;

	@ApiProperty({ enum: ['pending', 'active', 'revoked'] })
	status!: 'pending' | 'active' | 'revoked';

	@ApiProperty()
	createdAt!: string;

	@ApiProperty({ nullable: true, type: String })
	lastUsedAt!: string | null;
}
