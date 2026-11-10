import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import {
	OrganizationStatus,
	PlatformStaffStatus,
	PrismaService,
	UserStatus,
} from '@nexcoderw/akiba-db';
import request from 'supertest';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { createOpenApiDocument } from '../../src/docs/swagger.js';
import {
	LOCAL_PLATFORM_CSRF_COOKIE,
	LOCAL_PLATFORM_SESSION_COOKIE,
} from '../../src/modules/platform/auth/platform-auth.constants.js';
import { ORGANIZATION_PERMISSION } from '../../src/modules/platform/organizations/platform-organizations.constants.js';
import {
	createPlatformOrganizationsDatabaseFixture,
	organizationFixture,
	organizationSessionFixture,
	ORGANIZATION_ID,
	ORGANIZATION_TIME,
} from '../fixtures/platform-organizations-database.fixture.js';

const ROOT = '/api/v1/platform/organizations';
const SESSION_TOKEN = 'a'.repeat(43);
const CSRF_TOKEN = 'b'.repeat(43);
const COOKIE = `${LOCAL_PLATFORM_SESSION_COOKIE}=${SESSION_TOKEN}; ${LOCAL_PLATFORM_CSRF_COOKIE}=${CSRF_TOKEN}`;
const ROUTES = [
	{ method: 'get', path: ROOT, permission: ORGANIZATION_PERMISSION.read, body: undefined },
	{
		method: 'get',
		path: `${ROOT}/${ORGANIZATION_ID}`,
		permission: ORGANIZATION_PERMISSION.read,
		body: undefined,
	},
	{
		method: 'post',
		path: ROOT,
		permission: ORGANIZATION_PERMISSION.create,
		body: { name: 'Kimihurura Supplies', slug: 'kimihurura' },
	},
	{
		method: 'patch',
		path: `${ROOT}/${ORGANIZATION_ID}`,
		permission: ORGANIZATION_PERMISSION.update,
		body: { name: 'Remera Trading' },
	},
	{
		method: 'post',
		path: `${ROOT}/${ORGANIZATION_ID}/activation`,
		permission: ORGANIZATION_PERMISSION.activate,
		body: { expectedUpdatedAt: ORGANIZATION_TIME.toISOString() },
	},
	{
		method: 'post',
		path: `${ROOT}/${ORGANIZATION_ID}/suspension`,
		permission: ORGANIZATION_PERMISSION.suspend,
		body: { expectedUpdatedAt: ORGANIZATION_TIME.toISOString() },
	},
	{
		method: 'post',
		path: `${ROOT}/${ORGANIZATION_ID}/archival`,
		permission: ORGANIZATION_PERMISSION.archive,
		body: { expectedUpdatedAt: ORGANIZATION_TIME.toISOString() },
	},
] as const;

describe('organization HTTP security (real guards, fake persistence)', () => {
	let application: NestExpressApplication | undefined;
	const database = createPlatformOrganizationsDatabaseFixture();
	let session = organizationSessionFixture(Object.values(ORGANIZATION_PERMISSION));

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue(database.prisma)
			.overrideProvider(getOptionsToken())
			.useValue([{ name: 'default', ttl: 60_000, limit: 10_000 }])
			.compile();
		application = module.createNestApplication<NestExpressApplication>();
		configureApplication(
			application,
			validateEnvironment({ NODE_ENV: 'test', SWAGGER_ENABLED: 'false' }),
		);
		await application.init();
	});
	beforeEach(() => {
		jest.clearAllMocks();
		session = organizationSessionFixture(Object.values(ORGANIZATION_PERMISSION));
		database.sessionFindUnique.mockReset().mockResolvedValue(session);
		database.findUnique.mockReset().mockResolvedValue(organizationFixture());
		database.auditCreate.mockReset().mockResolvedValue({
			id: '77777777-7777-4777-8777-777777777777',
		});
	});
	afterAll(async () => {
		await application?.close();
	});

	function app(): NestExpressApplication {
		if (application === undefined)
			throw new Error('Organization HTTP application is not initialized.');
		return application;
	}
	function call(route: (typeof ROUTES)[number], cookie = COOKIE) {
		const agent = request(app().getHttpServer());
		const operation =
			route.method === 'get'
				? agent.get(route.path)
				: route.method === 'patch'
					? agent.patch(route.path)
					: agent.post(route.path);
		operation
			.set('Cookie', cookie)
			.set('Origin', 'http://localhost:4000')
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.set('If-Match', `"${ORGANIZATION_TIME.toISOString()}"`);
		if (route.body !== undefined) operation.send(route.body);
		return operation;
	}
	function prepareMutation(route: (typeof ROUTES)[number]) {
		const previous = organizationFixture();
		if (route.permission === ORGANIZATION_PERMISSION.suspend) {
			previous.status = OrganizationStatus.ACTIVE;
			previous.activatedAt = ORGANIZATION_TIME;
		}
		const result = { ...previous, updatedAt: new Date(ORGANIZATION_TIME.getTime() + 1) };
		if (route.permission === ORGANIZATION_PERMISSION.update) result.name = 'Remera Trading';
		if (route.permission === ORGANIZATION_PERMISSION.activate) {
			result.status = OrganizationStatus.ACTIVE;
		}
		if (route.permission === ORGANIZATION_PERMISSION.suspend) {
			result.status = OrganizationStatus.SUSPENDED;
		}
		if (route.permission === ORGANIZATION_PERMISSION.archive) {
			result.status = OrganizationStatus.ARCHIVED;
		}
		database.findUnique.mockResolvedValueOnce(previous).mockResolvedValueOnce(result);
	}

	it.each(ROUTES)('requires authentication for $method $path', async (route) => {
		await call(route, '').expect(401).expect('Cache-Control', 'no-store');
		expect(database.findMany).not.toHaveBeenCalled();
		expect(database.create).not.toHaveBeenCalled();
	});
	it('allows existing trusted system owners to read organizations without manual grants', async () => {
		database.sessionFindUnique.mockResolvedValue({
			...session,
			platformStaff: {
				...session.platformStaff,
				roles: [
					{
						platformRole: {
							key: 'platform.owner',
							isSystem: true,
							permissions: [],
						},
					},
				],
			},
		});
		await request(app().getHttpServer())
			.get(ROOT)
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', COOKIE)
			.expect(200);
		expect(database.findMany).toHaveBeenCalled();
	});
	it.each(ROUTES.filter((route) => route.method !== 'get'))(
		'allows trusted system owners to perform audited mutations: $method $path',
		async (route) => {
			database.sessionFindUnique.mockResolvedValue({
				...session,
				platformStaff: {
					...session.platformStaff,
					roles: [
						{
							platformRole: {
								key: 'platform.owner',
								isSystem: true,
								permissions: [],
							},
						},
					],
				},
			});
			prepareMutation(route);
			await call(route).expect(route.path === ROOT ? 201 : 200);
			expect(database.auditCreate).toHaveBeenCalledTimes(1);
			expect(database.auditCreate.mock.calls[0]?.[0]).toMatchObject({
				data: { actorPlatformStaffId: session.platformStaff.id, organizationId: ORGANIZATION_ID },
			});
			if (route.permission === ORGANIZATION_PERMISSION.archive) {
				expect(database.auditCreate.mock.calls[0]?.[0]).toMatchObject({
					data: {
						action: 'ARCHIVE',
						previousStatus: 'PENDING',
						resultingStatus: 'ARCHIVED',
						changedFields: ['status', 'archivedAt'],
						previousName: null,
						resultingName: null,
					},
				});
			}
		},
	);

	it.each(ROUTES)('denies dashboard-only staff for $method $path', async (route) => {
		database.sessionFindUnique.mockResolvedValue(
			organizationSessionFixture(['platform.dashboard.read']),
		);
		await call(route).set('x-platform-permissions', route.permission).expect(403);
		expect(database.findMany).not.toHaveBeenCalled();
		expect(database.create).not.toHaveBeenCalled();
	});
	it.each(['expired', 'revoked', 'suspended-user', 'revoked-staff'])(
		'denies %s identities on every organization route',
		async (condition) => {
			if (condition === 'expired') session.expiresAt = new Date(0);
			if (condition === 'revoked') session.revokedAt = new Date(0);
			if (condition === 'suspended-user') session.platformStaff.user.status = UserStatus.SUSPENDED;
			if (condition === 'revoked-staff') session.platformStaff.status = PlatformStaffStatus.REVOKED;
			for (const route of ROUTES) await call(route).expect(401);
			expect(database.create).not.toHaveBeenCalled();
		},
	);
	it('returns safe reads and rejects malformed filters, cursor and UUID', async () => {
		await request(app().getHttpServer())
			.get(ROOT)
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', COOKIE)
			.expect(200)
			.expect('Cache-Control', 'no-store');
		const response = await request(app().getHttpServer())
			.get(`${ROOT}/${ORGANIZATION_ID}`)
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', COOKIE)
			.expect(200);
		const body: unknown = response.body;
		expect(body).toMatchObject({
			id: ORGANIZATION_ID,
			name: 'Kimihurura Supplies',
			status: 'PENDING',
		});
		expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN);
		expect(response.get('ETag')).toBe(`"${ORGANIZATION_TIME.toISOString()}"`);
		for (const path of [
			`${ROOT}?limit=51`,
			`${ROOT}?cursor=bad`,
			`${ROOT}?status=enabled`,
			`${ROOT}?include=user`,
			`${ROOT}/bad`,
		]) {
			await request(app().getHttpServer())
				.get(path)
				.set('Origin', 'http://localhost:4000')
				.set('Cookie', COOKIE)
				.expect(400);
		}
	});
	it('re-resolves permission removal rather than trusting role names or prior reads', async () => {
		await call(ROUTES[0]).expect(200);
		database.sessionFindUnique.mockResolvedValue(
			organizationSessionFixture(['platform.dashboard.read']),
		);
		await call(ROUTES[0]).expect(403);
	});
	it('denies a tenant cookie and preserves dashboard/session endpoints', async () => {
		await call(ROUTES[0], `organization-user-session=${SESSION_TOKEN}`).expect(401);
		database.sessionFindUnique.mockResolvedValue(
			organizationSessionFixture(['platform.dashboard.read']),
		);
		await request(app().getHttpServer())
			.get('/api/v1/platform/auth/session')
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', COOKIE)
			.expect(200);
		await request(app().getHttpServer())
			.get('/api/v1/platform/dashboard/summary')
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', COOKIE)
			.expect(200);
	});
	it.each(ROUTES.filter((route) => route.method !== 'get'))(
		'checks Origin, CSRF and audit availability for $path',
		async (route) => {
			await call(route).set('Origin', 'https://attacker.example.invalid').expect(403);
			await call(route).set('x-platform-csrf-token', 'c'.repeat(43)).expect(403);
			await call(route).send({ untrusted: true }).expect(400);
			expect(database.create).not.toHaveBeenCalled();
			expect(database.updateMany).not.toHaveBeenCalled();
			prepareMutation(route);
			database.auditCreate.mockRejectedValueOnce(new Error('private audit failure'));
			const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
			const accessLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
			try {
				const response = await call(route).expect(503);
				const body: unknown = response.body;
				expect(body).toMatchObject({ code: 'ORGANIZATION_AUDIT_UNAVAILABLE' });
				expect(database.auditCreate).toHaveBeenCalledTimes(1);
				expect(JSON.stringify(body)).not.toContain('private audit failure');
				const records: unknown[] = accessLog.mock.calls.map(([entry]) => {
					if (typeof entry !== 'string') return null;
					try {
						return JSON.parse(entry) as unknown;
					} catch {
						return null;
					}
				});
				expect(records).toContainEqual(
					expect.objectContaining({
						event: 'request.completed',
						status: 503,
						errorCode: 'ORGANIZATION_AUDIT_UNAVAILABLE',
					}),
				);
			} finally {
				errorLog.mockRestore();
				accessLog.mockRestore();
			}
		},
	);
	it('reports missing organizations and sanitizes persistence failures', async () => {
		database.findUnique.mockResolvedValueOnce(null);
		await call(ROUTES[1]).expect(404);
		const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		try {
			database.findUnique.mockRejectedValueOnce(new Error('SQL secret=private'));
			const response = await call(ROUTES[1]).expect(503);
			expect(JSON.stringify(response.body)).not.toContain('SQL secret');
		} finally {
			errorLog.mockRestore();
		}
	});
	it('documents every route and the atomic audit failure boundary', () => {
		const document = createOpenApiDocument(app());
		expect(document.servers?.[0]?.url).toBe('/');
		expect(document.paths['/api/v1/platform/organizations']?.get?.security).toEqual([
			{ 'platform-session': [] },
		]);
		// configureApplication adds version/prefix; inspect matching paths without relying on test-global mode.
		for (const path of Object.keys(document.paths).filter((path) =>
			path.includes('platform/organizations'),
		)) {
			const item = document.paths[path];
			for (const method of ['get', 'post', 'patch'] as const) {
				const operation = item?.[method];
				if (operation === undefined) continue;
				expect(operation.responses['401']).toBeDefined();
				expect(operation.responses['403']).toBeDefined();
				if (method !== 'get') expect(operation.description).toContain('503');
			}
		}
	});
});
