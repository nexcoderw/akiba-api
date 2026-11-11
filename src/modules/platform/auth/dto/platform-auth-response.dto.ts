import { ApiProperty } from '@nestjs/swagger';

export class PlatformMfaChallengeResponseDto {
	@ApiProperty({ enum: ['MFA_REQUIRED'], example: 'MFA_REQUIRED' })
	status!: 'MFA_REQUIRED';

	@ApiProperty({ enum: ['VERIFY_MFA'], example: 'VERIFY_MFA' })
	nextStep!: 'VERIFY_MFA';

	@ApiProperty({ example: 'fictional-csrf-token' })
	csrfToken!: string;

	@ApiProperty({ example: '2026-10-13T10:05:00.000Z' })
	expiresAt!: string;

	@ApiProperty({ enum: ['email_otp', 'totp', 'recovery_code'], isArray: true, example: ['totp'] })
	methods!: ('email_otp' | 'totp' | 'recovery_code')[];
}

export class PlatformEmailOtpSentResponseDto {
	@ApiProperty({ enum: ['sent'], example: 'sent' })
	status!: 'sent';

	@ApiProperty({ example: '2026-10-14T10:05:00.000Z' })
	expiresAt!: string;

	@ApiProperty({ example: 60, description: 'Minimum seconds before another send attempt.' })
	retryAfterSeconds!: number;
}

export class PlatformMfaVerifiedResponseDto {
	@ApiProperty({ example: 'authenticated', enum: ['authenticated'] })
	status!: 'authenticated';

	@ApiProperty({ example: '2026-10-13T18:00:00.000Z' })
	expiresAt!: string;

	@ApiProperty({ example: 'fictional-rotated-csrf-token' })
	csrfToken!: string;
}

export class PlatformSessionResponseDto {
	@ApiProperty({ example: true })
	authenticated!: true;

	@ApiProperty({ example: true })
	mfaVerified!: true;

	@ApiProperty({ example: '2f5298af-cf42-4e66-8968-a42be74cb34b' })
	userId!: string;

	@ApiProperty({ example: 'Akiba Administrator' })
	displayName!: string;

	@ApiProperty({ example: 'admin@example.com' })
	email!: string;

	@ApiProperty({ example: 'a652ac64-47b5-499e-a849-dca02166c46b' })
	platformStaffId!: string;

	@ApiProperty({ example: '2026-10-13T18:00:00.000Z' })
	expiresAt!: string;

	@ApiProperty({ example: ['platform.operator'], isArray: true })
	roles!: string[];

	@ApiProperty({ example: ['platform.dashboard.read'], isArray: true })
	permissions!: string[];
}
