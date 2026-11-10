import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { AppModule } from '../../src/app.module.js';
import { createOpenApiDocument } from '../../src/docs/swagger.js';

describe('OpenAPI integration', () => {
	let application: INestApplication;

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(PrismaService)
			.useValue({})
			.compile();
		application = module.createNestApplication();
		await application.init();
	});

	afterAll(async () => {
		await application.close();
	});

	it('documents the liveness endpoint and response contract', () => {
		const document = createOpenApiDocument(application);
		const operation = document.paths['/health/live']?.get;

		expect(operation?.summary).toBe('Check process liveness');
		expect(operation?.responses['200']).toBeDefined();
		expect(operation?.responses['429']).toBeDefined();
	});

	it('documents every platform authentication endpoint', () => {
		const document = createOpenApiDocument(application);

		expect(document.paths['/platform/auth/login']?.post?.responses['200']).toBeDefined();
		expect(document.paths['/platform/auth/mfa/verify']?.post?.responses['200']).toBeDefined();
		expect(document.paths['/platform/auth/session']?.get?.responses['401']).toBeDefined();
		expect(document.paths['/platform/auth/logout']?.post?.responses['204']).toBeDefined();
	});

	it('documents error media/schema/headers and excludes retired commercial routes', () => {
		const document = createOpenApiDocument(application);
		const response = document.paths['/platform/auth/session']?.get?.responses['401'];
		if (response === undefined || !('content' in response)) {
			throw new Error('Expected an authentication Problem Details response.');
		}
		expect(response.content).toEqual({
			'application/problem+json': { schema: { $ref: '#/components/schemas/ApiErrorResponseDto' } },
		});
		expect(response.headers).toHaveProperty('X-Request-Id');
		expect(document.components?.schemas?.ApiErrorResponseDto).toBeDefined();
		expect(Object.keys(document.paths).join(' ')).not.toMatch(
			/membership-plans|payments|members|reminders|reports/u,
		);
	});

	it('documents dashboard cookie authentication, permission, errors, and safe response headers', () => {
		const document = createOpenApiDocument(application);
		const operation = document.paths['/platform/dashboard/summary']?.get;
		expect(operation?.tags).toEqual(['Platform dashboard']);
		expect(operation?.security).toEqual([{ 'platform-session': [] }]);
		expect(operation?.description).toContain('platform.dashboard.read');
		for (const status of ['200', '401', '403', '429', '500']) {
			expect(operation?.responses[status]).toBeDefined();
		}
		const response = operation?.responses['200'];
		if (response === undefined || !('content' in response)) {
			throw new Error('Expected a documented dashboard response.');
		}
		expect(response.headers).toMatchObject({
			'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
		});
		expect(response.content?.['application/json']?.schema).toEqual({
			$ref: '#/components/schemas/PlatformDashboardSummaryDto',
		});
		expect(response.content?.['application/json']?.example).toEqual({
			generatedAt: '2026-10-13T08:00:00.000Z',
			globalUsers: { total: 1 },
			platformStaff: { total: 1, pending: 0, active: 1, suspended: 0, revoked: 0 },
			platformRoles: { total: 1 },
			platformPermissions: { total: 1 },
		});
	});

	it('publishes only the approved dashboard fields with required nonnegative numeric counts', () => {
		const document = createOpenApiDocument(application);
		const summary = document.components?.schemas?.PlatformDashboardSummaryDto;
		if (summary === undefined || !('properties' in summary)) {
			throw new Error('Expected the dashboard summary schema.');
		}
		const fields = [
			'generatedAt',
			'globalUsers',
			'platformStaff',
			'platformRoles',
			'platformPermissions',
		];
		expect(Object.keys(summary.properties ?? {}).sort()).toEqual([...fields].sort());
		expect(summary.required?.slice().sort()).toEqual([...fields].sort());
		expect(summary.properties?.generatedAt).toMatchObject({ type: 'string', format: 'date-time' });
		for (const name of ['PlatformDashboardCountDto', 'PlatformDashboardStaffDto']) {
			const schema = document.components?.schemas?.[name];
			if (schema === undefined || !('properties' in schema)) {
				throw new Error('Expected a dashboard count schema.');
			}
			const countFields =
				name === 'PlatformDashboardCountDto'
					? ['total']
					: ['total', 'pending', 'active', 'suspended', 'revoked'];
			expect(Object.keys(schema.properties ?? {}).sort()).toEqual(countFields.slice().sort());
			expect(schema.required?.slice().sort()).toEqual(countFields.slice().sort());
			for (const field of countFields) {
				expect(schema.properties?.[field]).toMatchObject({ type: 'integer', minimum: 0 });
			}
		}
	});
});
