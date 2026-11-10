import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.types.js';

const TOKEN_BYTES = 32;

@Injectable()
export class OwnerTokenService {
	private readonly sessionPepper: Buffer;
	private readonly enrollmentPepper: Buffer;

	constructor(config: ConfigService<EnvironmentVariables, true>) {
		const sessionPepper = config.get('OWNER_AUTH_TOKEN_PEPPER', { infer: true });
		const enrollmentPepper = config.get('OWNER_ENROLLMENT_TOKEN_PEPPER', { infer: true });
		if (typeof sessionPepper !== 'string' || typeof enrollmentPepper !== 'string') {
			throw new Error('Owner authentication token peppers must be validated strings.');
		}
		this.sessionPepper = Buffer.from(sessionPepper, 'base64');
		this.enrollmentPepper = Buffer.from(enrollmentPepper, 'base64');
	}

	create(): string {
		return randomBytes(TOKEN_BYTES).toString('base64url');
	}

	isValid(token: string): boolean {
		return (
			/^[A-Za-z0-9_-]{43}$/u.test(token) &&
			Buffer.from(token, 'base64url').toString('base64url') === token
		);
	}

	sessionDigest(token: string): string {
		return this.digest(this.sessionPepper, 'organization-owner-session-v1', token);
	}

	enrollmentDigest(token: string): string {
		return this.digest(this.enrollmentPepper, 'organization-owner-enrollment-v1', token);
	}

	rateLimitDigest(value: string): string {
		return this.digest(this.sessionPepper, 'organization-owner-rate-limit-v1', value);
	}

	equal(left: string, right: string): boolean {
		const leftBuffer = Buffer.from(left, 'utf8');
		const rightBuffer = Buffer.from(right, 'utf8');
		return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
	}

	private digest(key: Buffer, purpose: string, value: string): string {
		return createHmac('sha256', key)
			.update(JSON.stringify([purpose, value]))
			.digest('hex');
	}
}
