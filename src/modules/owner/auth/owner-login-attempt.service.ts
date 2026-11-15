import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { OwnerTokenService } from './owner-token.service.js';

interface AttemptWindow {
	count: number;
	expiresAt: number;
}

const MAXIMUM_TRACKED_KEYS = 10_000;

@Injectable()
export class OwnerLoginAttemptService {
	private readonly attempts = new Map<string, AttemptWindow>();
	private readonly windowMilliseconds: number;
	private readonly limit: number;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly tokens: OwnerTokenService,
	) {
		this.windowMilliseconds = config.get('OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS', { infer: true });
		this.limit = config.get('OWNER_AUTH_LOGIN_ATTEMPT_LIMIT', { infer: true });
	}

	private assertAllowed(ipAddress: string, normalizedEmail: string, now: number): void {
		for (const key of this.keys(ipAddress, normalizedEmail)) {
			const window = this.attempts.get(key);
			if (window !== undefined && window.expiresAt > now && window.count >= this.limit) {
				throw new HttpException(
					{
						code: 'OWNER_LOGIN_RATE_LIMITED',
						message: 'Too many authentication attempts; try again later',
					},
					HttpStatus.TOO_MANY_REQUESTS,
				);
			}
		}
	}

	/** Reserve admission before asynchronous lookup/hash work; never evict a live abuse counter. */
	consume(ipAddress: string, normalizedEmail: string, now = Date.now()): void {
		this.assertAllowed(ipAddress, normalizedEmail, now);
		this.prune(now);
		const keys = this.keys(ipAddress, normalizedEmail);
		const additions = keys.filter((key) => !this.attempts.has(key)).length;
		if (this.attempts.size + additions > MAXIMUM_TRACKED_KEYS) {
			throw new ServiceUnavailableException({
				code: 'OWNER_LOGIN_UNAVAILABLE',
				message: 'Sign-in is temporarily unavailable. Try again.',
			});
		}
		for (const key of keys) {
			const current = this.attempts.get(key);
			this.attempts.set(key, {
				count: current === undefined || current.expiresAt <= now ? 1 : current.count + 1,
				expiresAt:
					current === undefined || current.expiresAt <= now
						? now + this.windowMilliseconds
						: current.expiresAt,
			});
		}
	}

	private keys(ipAddress: string, normalizedEmail: string): string[] {
		return [this.key('ip', ipAddress), this.key('account', normalizedEmail)];
	}

	private key(scope: string, value: string): string {
		return `${scope}:${this.tokens.rateLimitDigest(value)}`;
	}

	private prune(now: number): void {
		for (const [key, window] of this.attempts) {
			if (window.expiresAt <= now) {
				this.attempts.delete(key);
			}
		}
	}
}
