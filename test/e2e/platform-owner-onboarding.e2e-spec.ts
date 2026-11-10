import { jest } from '@jest/globals';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import {
	OrganizationOwnerInvitationStatus,
	PlatformStaffStatus,
	PrismaService,
	UserStatus,
} from '@nexcoderw/akiba-db';
import request from 'supertest';

import { configureApplication } from '../../src/app-bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { createOpenApiDocument } from '../../src/docs/swagger.js';
import {
	LOCAL_PLATFORM_CSRF_COOKIE,
	LOCAL_PLATFORM_SESSION_COOKIE,
} from '../../src/modules/platform/auth/platform-auth.constants.js';
import { OWNER_INVITATION_PERMISSION } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.constants.js';
import {
	createPlatformOwnerOnboardingDatabaseFixture,
	OWNER_INVITATION_ACTOR_ID,
	OWNER_INVITATION_ID,
	ownerInvitationFixture,
} from '../fixtures/platform-owner-onboarding-database.fixture.js';
import {
	organizationFixture,
	organizationSessionFixture,
	ORGANIZATION_ID,
} from '../fixtures/platform-organizations-database.fixture.js';

const ROOT = `/api/v1/platform/organizations/${ORGANIZATION_ID}/owner-invitations`;
const SESSION_TOKEN = 'a'.repeat(43);
const CSRF_TOKEN = 'b'.repeat(43);
const COOKIE = `${LOCAL_PLATFORM_SESSION_COOKIE}=${SESSION_TOKEN}; ${LOCAL_PLATFORM_CSRF_COOKIE}=${CSRF_TOKEN}`;
const CREATE_BODY = { displayName: ' Aline Uwase ', email: 'ALINE@EXAMPLE.COM' };

describe('owner onboarding HTTP security (real guards, fake persistence)', () => {
	let application: NestExpressApplication | undefined;
	const database = createPlatformOwnerOnboardingDatabaseFixture();

	beforeAll(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] })
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
		database.sessionFindUnique
			.mockReset()
			.mockResolvedValue(organizationSessionFixture(Object.values(OWNER_INVITATION_PERMISSION)));
		database.findUnique.mockReset().mockResolvedValue(organizationFixture());
		database.invitationFindFirst.mockReset().mockResolvedValue(ownerInvitationFixture());
		database.invitationFindMany.mockReset().mockResolvedValue([ownerInvitationFixture()]);
		database.invitationCreate.mockReset().mockResolvedValue(ownerInvitationFixture());
		database.invitationUpdateMany.mockReset().mockResolvedValue({ count: 1 });
		database.ownershipAuditCreate.mockReset().mockResolvedValue({
			id: '66666666-6666-4666-8666-666666666666',
		});
	});
	afterAll(async () => application?.close());

	function app(): NestExpressApplication {
		if (application === undefined) throw new Error('Owner onboarding application is unavailable.');
		return application;
	}
	function create(cookie = COOKIE) {
		return request(app().getHttpServer())
			.post(ROOT)
			.set('Cookie', cookie)
			.set('Origin', 'http://localhost:4000')
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send(CREATE_BODY);
	}
	function revoke(cookie = COOKIE) {
		return request(app().getHttpServer())
			.post(`${ROOT}/${OWNER_INVITATION_ID}/revocation`)
			.set('Cookie', cookie)
			.set('Origin', 'http://localhost:4000')
			.set('x-platform-csrf-token', CSRF_TOKEN);
	}
	function list(path = ROOT, cookie = COOKIE) {
		return request(app().getHttpServer())
			.get(path)
			.set('Cookie', cookie)
			.set('Origin', 'http://localhost:4000');
	}

	it('requires authentication and distinct permissions for every route', async () => {
		await create('').expect(401);
		await list(ROOT, '').expect(401);
		await revoke('').expect(401);

		for (const permission of Object.values(OWNER_INVITATION_PERMISSION)) {
			database.sessionFindUnique.mockResolvedValue(
				organizationSessionFixture(
					Object.values(OWNER_INVITATION_PERMISSION).filter((value) => value !== permission),
				),
			);
			if (permission === OWNER_INVITATION_PERMISSION.invite) await create().expect(403);
			if (permission === OWNER_INVITATION_PERMISSION.read) {
				await list().expect(403);
			}
			if (permission === OWNER_INVITATION_PERMISSION.revoke) await revoke().expect(403);
		}
	});

	it.each(['expired-session', 'suspended-user', 'suspended-staff'])(
		'rejects an otherwise permitted %s before invitation persistence',
		async (condition) => {
			const session = organizationSessionFixture(Object.values(OWNER_INVITATION_PERMISSION));
			if (condition === 'expired-session') session.expiresAt = new Date(0);
			if (condition === 'suspended-user') {
				session.platformStaff.user.status = UserStatus.SUSPENDED;
			}
			if (condition === 'suspended-staff') {
				session.platformStaff.status = PlatformStaffStatus.SUSPENDED;
			}
			database.sessionFindUnique.mockResolvedValue(session);
			await create().expect(401);
			expect(database.invitationCreate).not.toHaveBeenCalled();
		},
	);

	it('lets the trusted system owner inherit the new permission catalog', async () => {
		const session = organizationSessionFixture([]);
		session.platformStaff.roles = [
			{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } },
		];
		database.sessionFindUnique.mockResolvedValue(session);
		await create().expect(201);
		await list().expect(200);
		const revoked = ownerInvitationFixture(OrganizationOwnerInvitationStatus.REVOKED);
		database.invitationFindFirst
			.mockResolvedValueOnce(ownerInvitationFixture())
			.mockResolvedValueOnce(revoked);
		await revoke().expect(200);
	});

	it('normalizes create input and never returns token or actor persistence fields', async () => {
		const response = await create().expect(201).expect('Cache-Control', 'no-store');
		expect(database.invitationCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { invitedDisplayName: 'Aline Uwase', invitedEmail: 'aline@example.com' },
		});
		expect(response.body).toMatchObject({
			id: OWNER_INVITATION_ID,
			organizationId: ORGANIZATION_ID,
			displayName: 'Aline Uwase',
			email: 'aline@example.com',
			status: 'PENDING_DELIVERY',
		});
		expect(JSON.stringify(response.body)).not.toContain('tokenDigest');
		expect(JSON.stringify(response.body)).not.toContain('invitedByPlatformStaffId');
		expect(database.userCreate).not.toHaveBeenCalled();
		expect(database.membershipCreate).not.toHaveBeenCalled();
	});

	it('enforces exact Origin, CSRF, UUIDs and an allowlisted request body', async () => {
		await create().set('Origin', 'https://attacker.example.invalid').expect(403);
		await create().set('x-platform-csrf-token', 'c'.repeat(43)).expect(403);
		await create()
			.send({ ...CREATE_BODY, role: 'OWNER' })
			.expect(400);
		await create().send({ displayName: ' ', email: 'invalid' }).expect(400);
		await request(app().getHttpServer())
			.post('/api/v1/platform/organizations/bad/owner-invitations')
			.set('Cookie', COOKIE)
			.set('Origin', 'http://localhost:4000')
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send(CREATE_BODY)
			.expect(400);
	});

	it('returns a bounded organization-scoped no-store list and validates filters', async () => {
		await list(`${ROOT}?limit=20&status=PENDING_DELIVERY`)
			.expect(200)
			.expect('Cache-Control', 'no-store');
		expect(database.invitationFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				organizationId: ORGANIZATION_ID,
				status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			},
			take: 21,
		});
		for (const suffix of ['?limit=51', '?status=unknown', '?cursor=bad', '?include=user']) {
			await list(`${ROOT}${suffix}`).expect(400);
		}
	});

	it('returns 404 for missing or cross-organization resources without leaking existence', async () => {
		database.findUnique.mockResolvedValueOnce(null);
		await create().expect(404);
		database.invitationFindFirst.mockResolvedValueOnce(null);
		await revoke().expect(404);
		expect(database.invitationFindFirst.mock.calls[0]?.[0]).toMatchObject({
			where: { id: OWNER_INVITATION_ID, organizationId: ORGANIZATION_ID },
		});
	});

	it('revokes only an outstanding invitation and appends the audit atomically', async () => {
		const revoked = ownerInvitationFixture(OrganizationOwnerInvitationStatus.REVOKED);
		database.invitationFindFirst
			.mockResolvedValueOnce(ownerInvitationFixture())
			.mockResolvedValueOnce(revoked);
		const response = await revoke().expect(200).expect('Cache-Control', 'no-store');
		const body: unknown = response.body;
		expect(body).toMatchObject({ status: 'REVOKED' });
		if (typeof body !== 'object' || body === null || !('revokedAt' in body)) {
			throw new Error('Expected a revokedAt response field');
		}
		expect(typeof body.revokedAt).toBe('string');
		const auditCall: unknown = database.ownershipAuditCreate.mock.calls[0]?.[0];
		expect(auditCall).toMatchObject({
			data: {
				action: 'INVITATION_REVOKED',
				organizationId: ORGANIZATION_ID,
				ownerInvitationId: OWNER_INVITATION_ID,
				actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
				previousInvitationStatus: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
				resultingInvitationStatus: OrganizationOwnerInvitationStatus.REVOKED,
			},
			select: { id: true },
		});
	});

	it('returns safe conflicts and fail-closed audit errors', async () => {
		database.invitationCreate.mockRejectedValueOnce({ code: 'P2002' });
		await create().expect(409);
		database.invitationFindFirst.mockResolvedValue(
			ownerInvitationFixture(OrganizationOwnerInvitationStatus.ACCEPTED),
		);
		await revoke().expect(409);
		database.ownershipAuditCreate.mockRejectedValueOnce(new Error('private audit diagnostic'));
		const response = await create().expect(503);
		expect(response.body).toMatchObject({ code: 'OWNER_INVITATION_AUDIT_UNAVAILABLE' });
		expect(JSON.stringify(response.body)).not.toContain('private audit diagnostic');
	});

	it('publishes all three secure owner invitation operations in OpenAPI', () => {
		const document = createOpenApiDocument(app());
		const base = '/api/v1/platform/organizations/{organizationId}/owner-invitations';
		const revocation = `${base}/{invitationId}/revocation`;
		expect(document.paths[base]?.post?.security).toEqual([{ 'platform-session': [] }]);
		expect(document.paths[base]?.get?.responses['200']).toBeDefined();
		expect(document.paths[revocation]?.post?.responses['409']).toBeDefined();
		expect(document.paths[base]?.post?.description).toContain('grants no identity');
		expect(document.paths[revocation]?.post?.description).toContain('No user, membership');
	});
});
