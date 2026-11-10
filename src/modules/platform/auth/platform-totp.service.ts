import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as OTPAuth from 'otpauth';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import type { AcceptedTotp } from './platform-auth.types.js';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_BYTES = 20;
const TOTP_ENCRYPTION_VERSION = 1;
const TOTP_ISSUER = 'Akiba';

export interface EncryptedTotpSecret {
	readonly platformStaffId: string;
	readonly encryptedSecret: Uint8Array;
	readonly initializationVector: Uint8Array;
	readonly authenticationTag: Uint8Array;
	readonly encryptionKeyId: string;
	readonly encryptionVersion: number;
}

export interface PlatformTotpEnrollment extends EncryptedTotpSecret {
	readonly secret: string;
	readonly enrollmentUri: string;
}

@Injectable()
export class PlatformTotpService {
	private readonly keyring: Readonly<Record<string, string>>;
	private readonly activeKeyId: string;

	constructor(config: ConfigService<EnvironmentVariables, true>) {
		this.keyring = config.get('PLATFORM_TOTP_KEYRING', { infer: true });
		this.activeKeyId = config.get('PLATFORM_TOTP_ACTIVE_KEY_ID', { infer: true });
	}

	/** Generates and encrypts one enrollment using the verifier's versioned AES-GCM format. */
	createEnrollment(platformStaffId: string, accountLabel: string): PlatformTotpEnrollment {
		const encodedKey = this.keyring[this.activeKeyId];
		if (encodedKey === undefined) {
			throw new Error('The active TOTP encryption key is unavailable.');
		}

		const secret = new OTPAuth.Secret({ size: TOTP_SECRET_BYTES });
		const base32Secret = secret.base32;
		const plaintext = Buffer.from(base32Secret, 'utf8');
		const initializationVector = randomBytes(12);
		try {
			const cipher = createCipheriv(
				'aes-256-gcm',
				Buffer.from(encodedKey, 'base64'),
				initializationVector,
			);
			cipher.setAAD(
				Buffer.from(
					`${platformStaffId}:${this.activeKeyId}:${String(TOTP_ENCRYPTION_VERSION)}`,
					'utf8',
				),
			);
			const encryptedSecret = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			const enrollmentUri = new OTPAuth.TOTP({
				issuer: TOTP_ISSUER,
				label: accountLabel,
				algorithm: 'SHA1',
				digits: 6,
				period: TOTP_PERIOD_SECONDS,
				secret,
			}).toString();
			return {
				platformStaffId,
				encryptedSecret,
				initializationVector,
				authenticationTag: cipher.getAuthTag(),
				encryptionKeyId: this.activeKeyId,
				encryptionVersion: TOTP_ENCRYPTION_VERSION,
				secret: base32Secret,
				enrollmentUri,
			};
		} finally {
			plaintext.fill(0);
			secret.bytes.fill(0);
		}
	}

	verify(credential: EncryptedTotpSecret, token: string, now: Date): AcceptedTotp | null {
		const key = this.keyring[credential.encryptionKeyId];
		if (key === undefined || credential.encryptionVersion !== 1) {
			return null;
		}

		let secretBuffer: Buffer | undefined;
		try {
			const decipher = createDecipheriv(
				'aes-256-gcm',
				Buffer.from(key, 'base64'),
				credential.initializationVector,
			);
			decipher.setAAD(
				Buffer.from(
					`${credential.platformStaffId}:${credential.encryptionKeyId}:${String(credential.encryptionVersion)}`,
					'utf8',
				),
			);
			decipher.setAuthTag(Buffer.from(credential.authenticationTag));
			secretBuffer = Buffer.concat([
				decipher.update(Buffer.from(credential.encryptedSecret)),
				decipher.final(),
			]);
			const secret = secretBuffer.toString('utf8');
			if (!/^[A-Z2-7]{16,128}$/u.test(secret)) {
				return null;
			}
			const totp = new OTPAuth.TOTP({
				algorithm: 'SHA1',
				digits: 6,
				period: TOTP_PERIOD_SECONDS,
				secret: OTPAuth.Secret.fromBase32(secret),
			});
			const delta = totp.validate({ token, timestamp: now.getTime(), window: 1 });
			if (delta === null) {
				return null;
			}
			return {
				timeStep: BigInt(Math.floor(now.getTime() / (TOTP_PERIOD_SECONDS * 1000)) + delta),
			};
		} catch {
			return null;
		} finally {
			secretBuffer?.fill(0);
		}
	}
}
