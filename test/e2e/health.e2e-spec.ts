import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';
import request from 'supertest';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';

describe('API foundation (e2e)', () => {
	let application: NestExpressApplication;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue({})
			.compile();
		application = module.createNestApplication<NestExpressApplication>();
		configureApplication(
			application,
			validateEnvironment({
				NODE_ENV: 'test',
				CORS_ORIGINS: 'http://localhost:4000,http://localhost:4001',
				SWAGGER_ENABLED: 'false',
			}),
		);
		await application.init();
	});

	afterAll(async () => {
		await application.close();
	});

	it('serves a versioned liveness response with security headers', async () => {
		const response = await request(application.getHttpServer())
			.get('/api/v1/health/live')
			.expect(200);
		const body: unknown = response.body;

		expect(typeof response.get('x-request-id')).toBe('string');
		expect(response.get('x-content-type-options')).toBe('nosniff');
		expect(isRecord(body)).toBe(true);
		if (!isRecord(body)) {
			throw new Error('Expected a liveness response object.');
		}
		expect(body.status).toBe('ok');
		expect(body.service).toBe('akiba-api');
		expect(body.version).toBe('0.1.0');
		expect(typeof body.timestamp).toBe('string');
		expect(typeof body.uptimeSeconds).toBe('number');
	});

	it('returns the stable error envelope for unknown routes', async () => {
		const response = await request(application.getHttpServer())
			.get('/api/v1/missing')
			.set('x-request-id', 'foundation-test')
			.expect(404);
		const body: unknown = response.body;

		expect(isRecord(body)).toBe(true);
		if (!isRecord(body)) {
			throw new Error('Expected an API error response object.');
		}
		expect(body.code).toBe('RESOURCE_NOT_FOUND');
		expect(body.detail).toBe('The requested resource is unavailable.');
		expect(body.requestId).toBe(response.get('x-request-id'));
		expect(body.requestId).not.toBe('foundation-test');
		expect(body.status).toBe(404);
		expect(body.path).toBeUndefined();
		expect(response.get('content-type')).toContain('application/problem+json');
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
