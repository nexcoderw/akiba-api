import { jest } from '@jest/globals';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';

import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { PlatformOwnerEnrollmentService } from '../../src/modules/platform/bootstrap/platform-owner-enrollment.service.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';

describe('first-owner enrollment HTTP boundary', () => {
	let application: NestExpressApplication;
	let storage: ThrottlerStorageService;
	const base = '/api/v1/platform/bootstrap/enrollment';
	const origin = 'http://localhost:4000';
	const token = 'a'.repeat(43);
	const expiresAt = '2030-01-01T00:15:00.000Z';
	const exchange = jest.fn(async () => ({ stage: 'password', expiresAt, token }));
	const status = jest.fn(async () => ({ stage: 'password', expiresAt }));
	const complete = jest.fn(async () => ({ recoveryCodes: Array.from({ length: 10 }, () => 'ABCD-'.repeat(7) + 'ABCD') }));
	const setup = jest.fn(async () => ({ secret: 'A'.repeat(32), version: 1 }));
	let cookies: string;
	let csrf: string;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule).useModule(OfflineDatabaseModule)
			.overrideProvider(PlatformOwnerEnrollmentService).useValue({
				exchange, status, setup, complete,
				password: jest.fn(async () => ({ stage: 'mfa', expiresAt })),
				cancel: jest.fn(async () => undefined),
			}).compile();
		application = module.createNestApplication<NestExpressApplication>();
		configureApplication(application, validateEnvironment({ NODE_ENV: 'test' }));
		await application.init();
		const instance = module.get<ThrottlerStorage>(ThrottlerStorage);
		if (!(instance instanceof ThrottlerStorageService)) throw new Error('Expected real throttle storage.');
		storage = instance;
		const response = await request(application.getHttpServer()).post(`${base}/exchange`)
			.set('Origin', origin).send({ token }).expect(200);
		const issued = response.get('Set-Cookie') ?? [];
		cookies = issued.map((value) => value.split(';')[0]).join('; ');
		const match = /akiba-platform-csrf=([^;]+)/u.exec(cookies);
		if (match?.[1] === undefined) throw new Error('Missing CSRF fixture.');
		csrf = match[1];
	});

	beforeEach(() => { jest.clearAllMocks(); storage.onApplicationShutdown(); });
	afterAll(async () => { await application?.close(); });

	it('exchanges only at the trusted Origin and never exposes the cookie proof in JSON', async () => {
		await request(application.getHttpServer()).post(`${base}/exchange`)
			.set('Origin', 'https://untrusted.example.com').send({ token }).expect(403);
		expect(exchange).not.toHaveBeenCalled();
		const response = await request(application.getHttpServer()).post(`${base}/exchange`)
			.set('Origin', origin).send({ token }).expect(200);
		expect(response.body).toEqual({ stage: 'password', expiresAt });
		expect(response.get('Cache-Control')).toBe('no-store');
		const issued = response.get('Set-Cookie') ?? [];
		expect(issued).toHaveLength(2);
		expect(issued.some((value) => value.startsWith('akiba-platform-session='))).toBe(false);
		expect(issued.find((value) => value.startsWith('akiba-platform-challenge='))).toContain('HttpOnly');
	});

	it.each(['status', 'password', 'setup', 'complete', 'cancel'])('rejects %s without CSRF', async (path) => {
		await request(application.getHttpServer()).post(`${base}/${path}`)
			.set('Origin', origin).set('Cookie', cookies).send({}).expect(403);
	});

	it('rejects privileged extra fields and malformed completion proofs', async () => {
		await request(application.getHttpServer()).post(`${base}/exchange`)
			.set('Origin', origin).send({ token, role: 'platform.owner' }).expect(400);
		await request(application.getHttpServer()).post(`${base}/complete`)
			.set('Origin', origin).set('Cookie', cookies).set('X-Platform-CSRF-Token', csrf)
			.send({ code: '123456', version: 0 }).expect(400);
		expect(complete).not.toHaveBeenCalled();
	});

	it('validates empty requests and requires the origin-sealed setup cookie', async () => {
		await request(application.getHttpServer()).post(`${base}/status`)
			.set('Origin', origin).set('Cookie', cookies).set('X-Platform-CSRF-Token', csrf)
			.send({ userId: 'other' }).expect(400);
		await request(application.getHttpServer()).post(`${base}/status`)
			.set('Origin', origin).set('Cookie', `akiba-platform-csrf=${csrf}`)
			.set('X-Platform-CSRF-Token', csrf).send({}).expect(401);
		expect(status).not.toHaveBeenCalled();
	});

	it('returns only key/version during setup and clears all four cookies on completion', async () => {
		const key = await request(application.getHttpServer()).post(`${base}/setup`)
			.set('Origin', origin).set('Cookie', cookies).set('X-Platform-CSRF-Token', csrf)
			.send({}).expect(200);
		expect(key.body).toEqual({ secret: 'A'.repeat(32), version: 1 });
		const done = await request(application.getHttpServer()).post(`${base}/complete`)
			.set('Origin', origin).set('Cookie', cookies).set('X-Platform-CSRF-Token', csrf)
			.send({ code: '123456', version: 1 }).expect(200);
		const cleared = done.get('Set-Cookie') ?? [];
		expect(cleared).toHaveLength(4);
		for (const cookie of cleared) expect(cookie).toMatch(/^[^=]+=;/u);
		expect(done.body).not.toHaveProperty('sessionToken');
	});
});
