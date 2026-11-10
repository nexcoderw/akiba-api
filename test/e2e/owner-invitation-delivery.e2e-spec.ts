import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import {
	OrganizationOwnerInvitationStatus as InvitationStatus,
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
import { createOpenApiDocument } from '../../src/docs/swagger.js';
import { ResendOwnerInvitationEmailService } from '../../src/infrastructure/email/resend-owner-invitation-email.service.js';
import {
	LOCAL_PLATFORM_CSRF_COOKIE,
	LOCAL_PLATFORM_SESSION_COOKIE,
} from '../../src/modules/platform/auth/platform-auth.constants.js';
import { PLATFORM_PERMISSION } from '../../src/modules/platform/auth/platform-permission.constants.js';
import { OwnerInvitationTokenService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token.service.js';
import { OWNER_INVITATION_PERMISSION } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.constants.js';
import {
	createInvitationDeliveryDatabaseFixture,
	invitationDeliveryConfig,
	invitationDeliveryInput,
} from '../fixtures/owner-invitation-delivery.fixture.js';
import { OWNER_INVITATION_ID } from '../fixtures/platform-owner-onboarding-database.fixture.js';
import {
	ORGANIZATION_ID,
	organizationSessionFixture,
} from '../fixtures/platform-organizations-database.fixture.js';

const ROUTE = `/api/v1/platform/organizations/${ORGANIZATION_ID}/owner-invitations/${OWNER_INVITATION_ID}/delivery`;
const PREVIEW = '/api/v1/owner-invitations/preview';
const CSRF = 'b'.repeat(43);
const COOKIE = `${LOCAL_PLATFORM_SESSION_COOKIE}=${'a'.repeat(43)}; ${LOCAL_PLATFORM_CSRF_COOKIE}=${CSRF}`;

describe('owner invitation delivery HTTP (real guards, DTOs, services; fake adapters)', () => {
	let app: NestExpressApplication;
	let database: ReturnType<typeof createInvitationDeliveryDatabaseFixture>;
	let tokens: OwnerInvitationTokenService;

	async function initialize(input = invitationDeliveryInput()): Promise<void> {
		const config = invitationDeliveryConfig(input);
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue(database.prisma)
			.overrideProvider(ConfigService)
			.useValue(config)
			.overrideProvider(getOptionsToken())
			.useValue([{ name: 'default', ttl: 60_000, limit: 10_000 }])
			.compile();
		expect(() => module.get(ResendOwnerInvitationEmailService)).toThrow();
		app = module.createNestApplication<NestExpressApplication>();
		configureApplication(app, { CORS_ORIGINS: ['http://localhost:4000'], SWAGGER_ENABLED: false });
		tokens = module.get(OwnerInvitationTokenService);
		await app.init();
	}

	beforeEach(async () => {
		database = createInvitationDeliveryDatabaseFixture();
		database.sessionFindUnique.mockResolvedValue(
			organizationSessionFixture([OWNER_INVITATION_PERMISSION.send]),
		);
		await initialize();
	});
	afterEach(async () => {
		await app.close();
	});

	function queue(route = ROUTE) {
		return request(app.getHttpServer())
			.post(route)
			.set('Cookie', COOKIE)
			.set('Origin', 'http://localhost:4000')
			.set('x-platform-csrf-token', CSRF)
			.send({});
	}
	function preview(token = tokens.generate()) {
		return request(app.getHttpServer()).post(PREVIEW).send({ token });
	}

	it.each(['missing', 'expired', 'revoked', 'suspended', 'suspended-user', 'permission'])(
		'denies %s authentication/authorization before reservation',
		async (condition) => {
			const session = organizationSessionFixture(
				condition === 'permission'
					? [PLATFORM_PERMISSION.dashboardRead]
					: [OWNER_INVITATION_PERMISSION.send],
			);
			if (condition === 'expired') session.expiresAt = new Date(0);
			if (condition === 'revoked') session.revokedAt = new Date();
			if (condition === 'suspended') session.platformStaff.status = PlatformStaffStatus.SUSPENDED;
			if (condition === 'suspended-user') session.platformStaff.user.status = UserStatus.SUSPENDED;
			database.sessionFindUnique.mockResolvedValue(session);
			await queue()
				.set('Cookie', condition === 'missing' ? '' : COOKIE)
				.expect(condition === 'permission' ? 403 : 401);
			expect(database.deliveryCreate).not.toHaveBeenCalled();
		},
	);

	it('requires exact Origin/CSRF, valid UUIDs and no recipient or destination fields', async () => {
		await queue().set('Origin', 'https://evil.example.invalid').expect(403);
		await queue().set('x-platform-csrf-token', 'c'.repeat(43)).expect(403);
		await queue().unset('x-platform-csrf-token').expect(403);
		await queue(ROUTE.replace(OWNER_INVITATION_ID, 'bad')).expect(400);
		await queue()
			.send({ recipient: 'other@example.com', acceptanceUrl: 'https://evil.invalid' })
			.expect(400);
		expect(database.deliveryCreate).not.toHaveBeenCalled();
	});

	it('returns 202 for one reservation and duplicates, never a token or membership', async () => {
		const first = await queue().expect(202).expect('Cache-Control', 'no-store');
		const second = await queue().expect(202);
		expect(first.body).toEqual({
			status: 'QUEUED',
			message: 'Invitation delivery has been queued.',
		});
		expect(second.body).toEqual(first.body);
		expect(database.deliveryCreate).toHaveBeenCalledTimes(1);
		expect(database.ownershipAuditCreate).toHaveBeenCalledTimes(1);
		expect(database.userCreate).not.toHaveBeenCalled();
		expect(database.membershipCreate).not.toHaveBeenCalled();
		expect(database.membershipRoleCreate).not.toHaveBeenCalled();
	});

	it('honors the trusted system-owner catalog without a guard bypass', async () => {
		const session = organizationSessionFixture([]);
		session.platformStaff.roles = [
			{ platformRole: { key: 'platform.owner', isSystem: true, permissions: [] } },
		];
		database.sessionFindUnique.mockResolvedValue(session);
		await queue().expect(202);
	});

	it('fails closed when disabled, missing the repair, or unable to audit', async () => {
		await app.close();
		await initialize({
			...invitationDeliveryInput(),
			OWNER_INVITATION_DELIVERY_ENABLED: 'false',
		});
		await queue().expect(503);
		await app.close();
		await initialize();
		database.state.ready = false;
		await queue().expect(503);
		database.state.ready = true;
		database.ownershipAuditCreate.mockRejectedValueOnce(new Error('protected details'));
		const failed = await queue().expect(503);
		expect(JSON.stringify(failed.body)).not.toContain('protected details');
		expect(database.state.delivery).toBeNull();
	});

	it('rejects ineligible invitations, missing parents and wrong organization relationships', async () => {
		database.state.invitation.status = InvitationStatus.REVOKED;
		await queue().expect(409);
		database.state.invitation.status = InvitationStatus.ACCEPTED;
		await queue().expect(409);
		database.invitationFind.mockResolvedValueOnce(null);
		const otherOrganizationId = '99999999-9999-4999-8999-999999999999';
		await queue(
			ROUTE.replace(`/organizations/${ORGANIZATION_ID}/`, `/organizations/${otherOrganizationId}/`),
		).expect(404);
		expect(database.invitationFind).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: otherOrganizationId, id: OWNER_INVITATION_ID },
			}),
		);
		database.findUnique.mockResolvedValueOnce(null);
		await queue().expect(404);
		expect(database.invitationFind).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: ORGANIZATION_ID, id: OWNER_INVITATION_ID },
			}),
		);
	});

	it.each(['digest', 'expired', 'revoked', 'accepted', 'suspended', 'archived'])(
		'uses generic public invalid responses for %s without account enumeration',
		async (condition) => {
			const token = tokens.generate();
			Object.assign(database.state.invitation, {
				status: InvitationStatus.SENT,
				tokenDigest: tokens.digest(token),
				expiresAt: new Date(database.state.now.getTime() + 60_000),
			});
			if (condition === 'digest') database.state.invitation.tokenDigest = 'f'.repeat(64);
			if (condition === 'expired') database.state.invitation.expiresAt = new Date(0);
			if (condition === 'revoked') database.state.invitation.status = InvitationStatus.REVOKED;
			if (condition === 'accepted') database.state.invitation.status = InvitationStatus.ACCEPTED;
			if (condition === 'suspended')
				database.state.invitation.organization.status = OrganizationStatus.SUSPENDED;
			if (condition === 'archived')
				database.state.invitation.organization.status = OrganizationStatus.ARCHIVED;
			const response = await preview(token).expect(401).expect('Cache-Control', 'no-store');
			expect(response.body).toMatchObject({ code: 'OWNER_INVITATION_INVALID' });
			expect(response.headers['set-cookie']).toBeUndefined();
			expect(JSON.stringify(response.body)).not.toContain('aline@example.com');
			expect(database.invitationUpdate).not.toHaveBeenCalled();
		},
	);

	it('previews only the organization name with no-store and no cookies or identity activation', async () => {
		const token = tokens.generate();
		Object.assign(database.state.invitation, {
			status: InvitationStatus.SENT,
			tokenDigest: tokens.digest(token),
			expiresAt: new Date(database.state.now.getTime() + 60_000),
		});
		const response = await preview(token).expect(200).expect('Cache-Control', 'no-store');
		expect(response.body).toEqual({ valid: true, organizationName: 'Kimihurura Supplies' });
		expect(response.headers['set-cookie']).toBeUndefined();
		expect(database.userCreate).not.toHaveBeenCalled();
		expect(database.membershipRoleCreate).not.toHaveBeenCalled();
	});

	it('bounds public input, enforces throttling and documents reviewed enrollment routes', async () => {
		await preview('x'.repeat(200)).expect(400);
		await request(app.getHttpServer())
			.post(PREVIEW)
			.send({ token: tokens.generate(), email: 'owner@example.com' })
			.expect(400);
		for (let attempt = 0; attempt < 8; attempt += 1) await preview().expect(401);
		await preview().expect(429);
		const paths = createOpenApiDocument(app).paths;
		expect(paths['/api/v1/owner-invitations/preview']?.post).toBeDefined();
		expect(
			paths[
				'/api/v1/platform/organizations/{organizationId}/owner-invitations/{invitationId}/delivery'
			]?.post,
		).toBeDefined();
		expect(paths['/api/v1/owner-enrollment/challenges']?.post).toBeDefined();
		expect(paths['/api/v1/owner-enrollment/acceptances']?.post).toBeDefined();
	});
});
