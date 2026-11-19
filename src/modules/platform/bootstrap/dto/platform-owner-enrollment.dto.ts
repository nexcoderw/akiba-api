import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class PlatformOwnerExchangeDto {
	@ApiProperty({ description: 'Single-use setup code received by email; never put it in a URL.', minLength: 43, maxLength: 43 })
	@IsString()
	@Matches(/^[A-Za-z0-9_-]{43}$/u)
	token!: string;
}

export class PlatformOwnerPasswordDto {
	@ApiProperty({ description: 'Unique NFC passphrase, 15–1024 characters and at most 4096 UTF-8 bytes.', minLength: 15, maxLength: 4096, writeOnly: true })
	@IsString()
	@MaxLength(4096)
	password!: string;
}

export class PlatformOwnerCompleteDto {
	@ApiProperty({ description: 'Current code from the newly enrolled authenticator.', example: '123456' })
	@IsString()
	@Matches(/^\d{6}$/u)
	code!: string;

	@ApiProperty({ description: 'Setup version returned with the latest key.', minimum: 1, maximum: 3 })
	@IsInt()
	@Min(1)
	@Max(3)
	version!: number;
}

export class PlatformOwnerStateDto {
	@ApiProperty({ enum: ['password', 'mfa'] })
	stage!: 'password' | 'mfa';
	@ApiProperty({ format: 'date-time' })
	expiresAt!: string;
}

export class PlatformOwnerSetupDto {
	@ApiProperty({ description: 'Base32 key shown only during setup. Do not log or persist in the browser.', minLength: 32, maxLength: 32 })
	secret!: string;
	@ApiProperty({ minimum: 1, maximum: 3 })
	version!: number;
}

export class PlatformOwnerRecoveryDto {
	@ApiProperty({ type: [String], description: 'Ten single-use recovery codes, disclosed exactly once.', minItems: 10, maxItems: 10 })
	recoveryCodes!: string[];
}
