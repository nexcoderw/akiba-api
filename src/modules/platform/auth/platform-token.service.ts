import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.types.js';

const TOKEN_BYTES = 32;

/** Creates opaque credentials and one-way keyed digests suitable for database lookup. */
@Injectable()
export class PlatformTokenService {
	private readonly pepper: Buffer;

	constructor(config: ConfigService<EnvironmentVariables, true>) {
		this.pepper = Buffer.from(config.get<string>('PLATFORM_AUTH_TOKEN_PEPPER'), 'base64');
	}

	createToken(): string {
		return randomBytes(TOKEN_BYTES).toString('base64url');
	}

	digest(token: string): string {
		return createHmac('sha256', this.pepper).update(token, 'utf8').digest('hex');
	}

	recoveryCodeDigest(code: string): string {
		return this.digest(JSON.stringify(['platform-recovery-code-v2', code.trim().toUpperCase()]));
	}

	createRecoveryCodes(): string[] {
		return Array.from({ length: 10 }, () =>
			randomBytes(16)
				.toString('hex')
				.toUpperCase()
				.replace(/.{4}(?=.)/gu, '$&-'),
		);
	}

	/** Bind low-entropy codes to one challenge and mailbox with the managed secret pepper. */
	emailOtpDigest(challengeId: string, email: string, code: string): string {
		return this.digest(
			JSON.stringify(['platform-email-otp-v1', challengeId, email.toLowerCase(), code]),
		);
	}

	equal(left: string, right: string): boolean {
		const leftBuffer = Buffer.from(left, 'utf8');
		const rightBuffer = Buffer.from(right, 'utf8');
		return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
	}
}
