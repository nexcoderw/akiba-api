import { ConfigService } from '@nestjs/config';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { OwnerLoginAttemptService } from '../../src/modules/owner/auth/owner-login-attempt.service.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const config = new ConfigService<EnvironmentVariables, true>(
	validateEnvironment({
		NODE_ENV: 'test',
		OWNER_AUTH_LOGIN_ATTEMPT_LIMIT: 2,
		OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS: 60_000,
	}),
);

function limiter(): OwnerLoginAttemptService {
	return new OwnerLoginAttemptService(config, new OwnerTokenService(config));
}

function expectRateLimit(operation: () => void): void {
	try {
		operation();
		throw new Error('Expected admission to be denied.');
	} catch (error: unknown) {
		if (!(error instanceof HttpException)) throw error;
		expect(error.getStatus()).toBe(429);
	}
}

describe('owner login admission hardening', () => {
	it('bounds both account and network attempts before any credential result exists', () => {
		const service = limiter();
		service.consume('192.0.2.1', 'owner@example.com', NOW);
		service.consume('192.0.2.1', 'owner@example.com', NOW);
		expectRateLimit(() => {
			service.consume('192.0.2.2', 'owner@example.com', NOW);
		});
		expectRateLimit(() => {
			service.consume('192.0.2.1', 'other@example.com', NOW);
		});
		expect(() => {
			service.consume('192.0.2.1', 'owner@example.com', NOW + 60_000);
		}).not.toThrow();
	});

	it('admits only the quota when callers concurrently request credential work', async () => {
		const service = limiter();
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () =>
				Promise.resolve().then(() => {
					service.consume('192.0.2.1', 'owner@example.com', NOW);
				}),
			),
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(18);
	});

	it('refuses new identities at capacity without evicting an unexpired blocked account', () => {
		const service = limiter();
		service.consume('victim-network', 'owner@example.com', NOW);
		service.consume('victim-network', 'owner@example.com', NOW);
		for (let index = 0; index < 4999; index += 1) {
			service.consume(
				`synthetic-network-${String(index)}`,
				`user-${String(index)}@example.com`,
				NOW,
			);
		}
		expect(() => {
			service.consume('overflow-network', 'overflow@example.com', NOW);
		}).toThrow(ServiceUnavailableException);
		expectRateLimit(() => {
			service.consume('another-network', 'owner@example.com', NOW);
		});
		expect(() => {
			service.consume('overflow-network', 'overflow@example.com', NOW + 60_000);
		}).not.toThrow();
	});
});
