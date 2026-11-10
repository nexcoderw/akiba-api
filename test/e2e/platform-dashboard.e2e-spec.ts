import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PlatformStaffStatus, PrismaService, UserStatus } from '@nexcoderw/akiba-db';
import request from 'supertest';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { LOCAL_PLATFORM_SESSION_COOKIE } from '../../src/modules/platform/auth/platform-auth.constants.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { createPlatformDashboardDatabaseFixture } from '../fixtures/platform-dashboard-database.fixture.js';

const ENDPOINT = '/api/v1/platform/dashboard/summary';
const ADMIN_ORIGIN = 'http://localhost:4000';
const SESSION_TOKEN = 'fictional-dashboard-session-token-at-least-32-characters';
const COOKIE = `${LOCAL_PLATFORM_SESSION_COOKIE}=${SESSION_TOKEN}`;

describe('platform dashboard HTTP API (real session and permission guards)', () => {
	let application: NestExpressApplication | undefined;
	let session: SessionRecord;
	const database = createPlatformDashboardDatabaseFixture();

	beforeAll(async () => {
		application = await createApplication(database, 100);
	});

	beforeEach(() => {
		session = createSession();
		database.sessionFindUnique.mockReset().mockResolvedValue(session);
		database.sessionUpdateMany.mockReset().mockResolvedValue({ count: 1 });
		database.userCount.mockReset().mockResolvedValue(4);
		database.staffGroupBy
			.mockReset()
			.mockResolvedValue([{ status: PlatformStaffStatus.ACTIVE, _count: { _all: 2 } }]);
		database.roleCount.mockReset().mockResolvedValue(3);
		database.permissionCount.mockReset().mockResolvedValue(5);
		database.runTransaction.mockClear();
	});

	afterAll(async () => {
		await application?.close();
	});

	function app(): NestExpressApplication {
		if (application === undefined)
			throw new Error('The dashboard application was not initialized.');
		return application;
	}

	function dashboardRequest(target = app()) {
		return request(target.getHttpServer()).get(ENDPOINT).set('Origin', ADMIN_ORIGIN);
	}

	it('returns only approved numeric aggregates and a UTC timestamp without caching or PII', async () => {
		const response = await dashboardRequest().set('Cookie', COOKIE).expect(200);
		const body: unknown = response.body;
		if (!isRecord(body) || typeof body.generatedAt !== 'string') {
			throw new Error('Expected a dashboard response with a timestamp.');
		}
		expect(body).toEqual({
			generatedAt: body.generatedAt,
			globalUsers: { total: 4 },
			platformStaff: { total: 2, pending: 0, active: 2, suspended: 0, revoked: 0 },
			platformRoles: { total: 3 },
			platformPermissions: { total: 5 },
		});
		expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
		expect(response.get('Cache-Control')).toBe('no-store');
		expect(response.type).toBe('application/json');
		for (const forbidden of [
			SESSION_TOKEN,
			session.platformStaff.user.email,
			session.platformStaff.user.displayName,
			'password',
			'tokenDigest',
			'encryptedSecret',
		]) {
			expect(JSON.stringify(body)).not.toContain(forbidden);
		}
		expect(database.sessionFindUnique.mock.calls[0]?.[0]).toMatchObject({
			where: { tokenDigest: app().get(PlatformTokenService).digest(SESSION_TOKEN) },
		});
	});

	it('rejects a missing session before reading statistics', async () => {
		await dashboardRequest().expect(401);
		expect(database.sessionFindUnique).not.toHaveBeenCalled();
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('rejects a tenant portal origin before reading the platform session', async () => {
		await request(app().getHttpServer())
			.get(ENDPOINT)
			.set('Origin', 'http://localhost:4001')
			.set('Cookie', COOKIE)
			.expect(403);
		expect(database.sessionFindUnique).not.toHaveBeenCalled();
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('rejects a malformed session token before database access', async () => {
		await dashboardRequest().set('Cookie', `${LOCAL_PLATFORM_SESSION_COOKIE}=short`).expect(401);
		expect(database.sessionFindUnique).not.toHaveBeenCalled();
	});

	it('rejects an unknown session token through the real session service', async () => {
		database.sessionFindUnique.mockResolvedValue(null);
		await dashboardRequest().set('Cookie', COOKIE).expect(401);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it.each([
		'expired',
		'idle-expired',
		'revoked',
		'suspended-user',
		'pending-staff',
		'suspended-staff',
		'revoked-staff',
		'future-mfa',
		'unverified-email',
		'changed-password',
	])('denies %s sessions before aggregate access', async (condition) => {
		const past = new Date(Date.now() - 60_000);
		switch (condition) {
			case 'expired':
				session.expiresAt = past;
				break;
			case 'idle-expired':
				session.idleExpiresAt = past;
				break;
			case 'revoked':
				session.revokedAt = past;
				break;
			case 'suspended-user':
				session.platformStaff.user.status = UserStatus.SUSPENDED;
				break;
			case 'pending-staff':
				session.platformStaff.status = PlatformStaffStatus.PENDING;
				break;
			case 'suspended-staff':
				session.platformStaff.status = PlatformStaffStatus.SUSPENDED;
				break;
			case 'revoked-staff':
				session.platformStaff.status = PlatformStaffStatus.REVOKED;
				break;
			case 'future-mfa':
				session.mfaVerifiedAt = new Date(Date.now() + 60_000);
				break;
			case 'unverified-email':
				session.platformStaff.user.emailVerifiedAt = null;
				break;
			case 'changed-password':
				session.platformStaff.user.passwordCredential.passwordChangedAt = new Date();
				break;
			default:
				throw new Error('An unsupported rejection fixture was requested.');
		}
		await dashboardRequest().set('Cookie', COOKIE).expect(401);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('returns 403 for a valid administrator without the dashboard permission', async () => {
		session.platformStaff.roles[0]?.platformRole.permissions.splice(0, 1, {
			platformPermission: { key: 'platform.other.read' },
		});
		await dashboardRequest().set('Cookie', COOKIE).expect(403);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('permits the explicit permission with a role other than platform.owner', async () => {
		expect(session.platformStaff.roles[0]?.platformRole.key).toBe('platform.auditor');
		await dashboardRequest().set('Cookie', COOKIE).expect(200);
	});

	it('denies non-system owner lookalikes even with forged authorization hints', async () => {
		session.platformStaff.roles = [
			{
				platformRole: {
					key: 'platform.owner',
					permissions: [{ platformPermission: { key: 'platform.other.read' } }],
				},
			},
		];
		await request(app().getHttpServer())
			.get(`${ENDPOINT}?organizationId=fictional-org&branchId=fictional-branch`)
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', COOKIE)
			.set('x-platform-permissions', 'platform.dashboard.read')
			.set('x-platform-role', 'platform.owner')
			.set('x-tenant-id', 'fictional-org')
			.expect(403);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('denies a non-system owner lookalike with no effective permissions', async () => {
		session.platformStaff.roles = [{ platformRole: { key: 'platform.owner', permissions: [] } }];
		await dashboardRequest().set('Cookie', COOKIE).expect(401);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('does not accept a normal organization user cookie or tenant ownership hints', async () => {
		await dashboardRequest()
			.set('Cookie', `organization-user-session=${SESSION_TOKEN}`)
			.set('x-role', 'organization.owner')
			.set('x-organization-id', 'fictional-org')
			.expect(401);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('re-resolves permissions on the next request after access is removed', async () => {
		await dashboardRequest().set('Cookie', COOKIE).expect(200);
		session.platformStaff.roles = [
			{
				platformRole: {
					key: 'platform.auditor',
					permissions: [{ platformPermission: { key: 'platform.other.read' } }],
				},
			},
		];
		database.userCount.mockClear();
		await dashboardRequest().set('Cookie', COOKIE).expect(403);
		expect(database.userCount).not.toHaveBeenCalled();
	});

	it('uses the centralized safe error envelope for aggregate failures', async () => {
		const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		try {
			database.userCount.mockRejectedValueOnce(
				new Error('fictional SQL failure secret=do-not-expose'),
			);
			const response = await dashboardRequest().set('Cookie', COOKIE).expect(500);
			const body: unknown = response.body;
			expect(body).toMatchObject({
				code: 'INTERNAL_ERROR',
				detail: 'An unexpected error occurred. Please try again later.',
			});
			expect(JSON.stringify(body)).not.toContain('fictional SQL');
			expect(JSON.stringify(body)).not.toContain('do-not-expose');
			expect(errorLog).toHaveBeenCalled();
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain('fictional SQL');
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain('do-not-expose');
		} finally {
			errorLog.mockRestore();
		}
	});

	it('retains the real global throttler and returns 429 when the request limit is exceeded', async () => {
		const limitedApp = await createApplication(database, 2);
		try {
			for (let index = 0; index < 2; index += 1) {
				await dashboardRequest(limitedApp).set('Cookie', COOKIE).expect(200);
			}
			const response = await dashboardRequest(limitedApp).set('Cookie', COOKIE).expect(429);
			const body: unknown = response.body;
			expect(body).toMatchObject({ code: 'RATE_LIMITED' });
		} finally {
			await limitedApp.close();
		}
	});
});

async function createApplication(
	database: ReturnType<typeof createPlatformDashboardDatabaseFixture>,
	limit: number,
): Promise<NestExpressApplication> {
	const module = await Test.createTestingModule({ imports: [AppModule] })
		.overrideModule(DatabaseIntegrationModule)
		.useModule(OfflineDatabaseModule)
		.overrideProvider(PrismaService)
		.useValue(database.prisma)
		.overrideProvider(getOptionsToken())
		.useValue([{ name: 'default', ttl: 60_000, limit }])
		.compile();
	const application = module.createNestApplication<NestExpressApplication>();
	configureApplication(
		application,
		validateEnvironment({ NODE_ENV: 'test', SWAGGER_ENABLED: 'false' }),
	);
	await application.init();
	return application;
}

interface SessionRecord {
	id: string;
	createdAt: Date;
	expiresAt: Date;
	idleExpiresAt: Date;
	revokedAt: Date | null;
	mfaVerifiedAt: Date;
	platformStaff: {
		id: string;
		status: PlatformStaffStatus;
		user: {
			id: string;
			email: string;
			displayName: string;
			status: UserStatus;
			emailVerifiedAt: Date | null;
			passwordCredential: { passwordChangedAt: Date };
		};
		roles: {
			platformRole: {
				key: string;
				permissions: { platformPermission: { key: string } }[];
			};
		}[];
	};
}

function createSession(): SessionRecord {
	const now = Date.now();
	return {
		id: 'fictional-platform-session',
		createdAt: new Date(now - 60_000),
		expiresAt: new Date(now + 3_600_000),
		idleExpiresAt: new Date(now + 1_800_000),
		revokedAt: null,
		mfaVerifiedAt: new Date(now - 60_000),
		platformStaff: {
			id: 'fictional-platform-staff',
			status: PlatformStaffStatus.ACTIVE,
			user: {
				id: 'fictional-global-user',
				email: 'auditor@example.invalid',
				displayName: 'Fictional Platform Auditor',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(now - 86_400_000),
				passwordCredential: { passwordChangedAt: new Date(now - 86_400_000) },
			},
			roles: [
				{
					platformRole: {
						key: 'platform.auditor',
						permissions: [{ platformPermission: { key: 'platform.dashboard.read' } }],
					},
				},
			],
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
