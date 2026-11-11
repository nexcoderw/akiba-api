import { ConfigService } from '@nestjs/config';
import express from 'express';
import request from 'supertest';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformCookieService } from '../../src/modules/platform/auth/platform-cookie.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';

describe('platform production cookie attributes', () => {
	const config = new ConfigService<EnvironmentVariables, true>(
		validateEnvironment({ NODE_ENV: 'test', PLATFORM_AUTH_COOKIE_SECURE: 'true' }),
	);
	const tokens = new PlatformTokenService(config);
	const cookies = new PlatformCookieService(config, tokens);
	const app = express();
	app.get('/set', (_request, response) => {
		const expiry = new Date('2030-01-01T00:05:00.000Z');
		cookies.setSession(response, tokens.createToken(), expiry);
		cookies.setChallenge(response, tokens.createToken(), expiry);
		cookies.setCsrf(response, tokens.createToken(), expiry);
		response.sendStatus(204);
	});
	app.post('/clear', (_request, response) => {
		cookies.clearSession(response);
		response.sendStatus(204);
	});

	it('sets distinct host-only secure cookies and hides authentication credentials from JavaScript', async () => {
		const response = await request(app).get('/set').expect(204);
		const issued = response.get('Set-Cookie') ?? [];
		expect(issued).toHaveLength(3);
		for (const name of ['session', 'challenge', 'csrf']) {
			const cookie = issued.find((value) => value.startsWith(`__Host-akiba-platform-${name}=`));
			expect(cookie).toContain('Secure');
			expect(cookie).toContain('SameSite=Strict');
			expect(cookie).toContain('Path=/');
			expect(cookie).not.toContain('Domain=');
			if (name !== 'csrf') expect(cookie).toContain('HttpOnly');
		}
	});

	it('expires all platform authentication cookies with their matching scope', async () => {
		const response = await request(app).post('/clear').expect(204);
		const expired = response.get('Set-Cookie') ?? [];
		expect(expired).toHaveLength(3);
		for (const cookie of expired) {
			expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
			expect(cookie).toContain('Secure');
			expect(cookie).not.toContain('Domain=');
		}
	});
});
