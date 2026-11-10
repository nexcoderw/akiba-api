import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.types.js';

export const OWNER_INVITATION_TOKEN_PURPOSE = 'organization-owner-invitation-v1';

@Injectable()
export class OwnerInvitationTokenService {
	constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

	generate(): string {
		return randomBytes(32).toString('base64url');
	}

	isValidFormat(token: string): boolean {
		return (
			/^[A-Za-z0-9_-]{43}$/u.test(token) &&
			Buffer.from(token, 'base64url').toString('base64url') === token
		);
	}

	digest(token: string): string {
		const settings = this.config.get('OWNER_INVITATION_DELIVERY', { infer: true });
		if (settings === null || !this.isValidFormat(token))
			throw new Error('Invitation token unavailable.');
		return createHmac('sha256', Buffer.from(settings.hmacSecret, 'base64'))
			.update(JSON.stringify([OWNER_INVITATION_TOKEN_PURPOSE, token]))
			.digest('hex');
	}

	matches(token: string, digest: string): boolean {
		if (!this.isValidFormat(token) || !/^[0-9a-f]{64}$/u.test(digest)) return false;
		return timingSafeEqual(Buffer.from(this.digest(token), 'hex'), Buffer.from(digest, 'hex'));
	}
}
