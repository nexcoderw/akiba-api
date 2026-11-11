import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformLoginAttemptService } from '../../src/modules/platform/auth/platform-login-attempt.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';

describe('PlatformLoginAttemptService', () => {
	const configuration = new ConfigService<EnvironmentVariables, true>(
		validateEnvironment({
			NODE_ENV: 'test',
			PLATFORM_AUTH_LOGIN_ATTEMPT_LIMIT: 2,
			PLATFORM_AUTH_LOGIN_ATTEMPT_WINDOW_MS: 60_000,
		}),
	);

	it('limits repeated attempts for both account and network source', () => {
		const service = new PlatformLoginAttemptService(
			configuration,
			new PlatformTokenService(configuration),
		);
		const now = Date.parse('2030-01-01T00:00:00.000Z');
		service.consume('192.0.2.10', 'admin@example.com', now);
		service.consume('192.0.2.10', 'admin@example.com', now);

		expect(() => {
			service.consume('192.0.2.10', 'other@example.com', now);
		}).toThrow(HttpException);
		expect(() => {
			service.consume('192.0.2.11', 'admin@example.com', now);
		}).toThrow(HttpException);
	});

	it('allows attempts again after the bounded window expires', () => {
		const service = new PlatformLoginAttemptService(
			configuration,
			new PlatformTokenService(configuration),
		);
		const now = Date.parse('2030-01-01T00:00:00.000Z');
		service.consume('192.0.2.10', 'admin@example.com', now);
		service.consume('192.0.2.10', 'admin@example.com', now);

		expect(() => {
			service.consume('192.0.2.10', 'admin@example.com', now + 60_001);
		}).not.toThrow();
	});
});
