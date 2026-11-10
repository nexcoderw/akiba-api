import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { AppModule } from '../../src/app.module.js';
import {
	DurableOwnerInvitationAudit,
	PlatformOwnerInvitationAudit,
} from '../../src/modules/platform/owner-onboarding/platform-owner-invitation-audit.js';
import { PlatformOwnerOnboardingController } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.controller.js';
import { PlatformOwnerOnboardingService } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.service.js';
import { OwnerInvitationDeliveryService } from '../../src/modules/platform/owner-onboarding/owner-invitation-delivery.service.js';
import { OwnerInvitationDeliveryWorkerService } from '../../src/modules/platform/owner-onboarding/owner-invitation-delivery-worker.service.js';
import { OwnerInvitationPreviewController } from '../../src/modules/platform/owner-onboarding/owner-invitation-preview.controller.js';
import {
	createPlatformOwnerOnboardingDatabaseFixture,
	OWNER_INVITATION_ACTOR_ID,
	OWNER_INVITATION_ID,
} from '../fixtures/platform-owner-onboarding-database.fixture.js';
import { ORGANIZATION_ID } from '../fixtures/platform-organizations-database.fixture.js';

import type { PlatformPrincipal } from '../../src/modules/platform/auth/platform-auth.types.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PLATFORM_PERMISSION } from '../../src/modules/platform/auth/platform-permission.constants.js';
import { organizationSessionFixture } from '../fixtures/platform-organizations-database.fixture.js';

describe('owner onboarding module integration (adapter fake; no live PostgreSQL)', () => {
	let module: TestingModule;
	let principal: PlatformPrincipal;
	const database = createPlatformOwnerOnboardingDatabaseFixture();

	beforeAll(async () => {
		module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue(database.prisma)
			.compile();
	});
	beforeEach(async () => {
		database.sessionFindUnique.mockResolvedValue(
			organizationSessionFixture(Object.values(PLATFORM_PERMISSION)),
		);
		principal = await module
			.get(PlatformSessionService)
			.authenticate('fictional-integration-session-with-at-least-32-characters');
		database.runTransaction.mockClear();
	});

	afterAll(async () => module.close());

	it('registers the controller, service and durable audit against the shared database provider', () => {
		expect(module.get(PrismaService)).toBe(database.prisma);
		expect(module.get(PlatformOwnerOnboardingController)).toBeDefined();
		expect(module.get(PlatformOwnerOnboardingService)).toBeDefined();
		expect(module.get(PlatformOwnerInvitationAudit)).toBeInstanceOf(DurableOwnerInvitationAudit);
		expect(() => module.get(OwnerInvitationDeliveryWorkerService)).toThrow();
		expect(module.get(OwnerInvitationPreviewController)).toBeDefined();
	});

	it('keeps the worker outside the HTTP container and refuses unapproved delivery', async () => {
		const callsBefore = database.runTransaction.mock.calls.length;
		await expect(
			module.get(OwnerInvitationDeliveryService).queue(
				{
					actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
					requestId: 'fictional-disabled-delivery',
				},
				principal,
				ORGANIZATION_ID,
				OWNER_INVITATION_ID,
			),
		).rejects.toMatchObject({
			status: 503,
			response: { code: 'OWNER_INVITATION_DELIVERY_UNAVAILABLE' },
		});
		expect(database.runTransaction).toHaveBeenCalledTimes(callsBefore + 1);
	});

	it('creates a pending invitation and an allowlisted audit record through one transaction', async () => {
		await expect(
			module.get(PlatformOwnerOnboardingService).create(
				{
					actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
					requestId: 'fictional-owner-invitation-request',
				},
				principal,
				ORGANIZATION_ID,
				{ displayName: 'Aline Uwase', email: 'aline@example.com' },
			),
		).resolves.toMatchObject({
			id: OWNER_INVITATION_ID,
			organizationId: ORGANIZATION_ID,
			status: 'PENDING_DELIVERY',
		});
		expect(database.runTransaction).toHaveBeenCalledTimes(2);
		const auditCall: unknown = database.ownershipAuditCreate.mock.calls[0]?.[0];
		expect(auditCall).toMatchObject({
			data: {
				organizationId: ORGANIZATION_ID,
				ownerInvitationId: OWNER_INVITATION_ID,
				actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
				action: 'INVITATION_CREATED',
				previousInvitationStatus: null,
				resultingInvitationStatus: 'PENDING_DELIVERY',
				requestId: 'fictional-owner-invitation-request',
			},
			select: { id: true },
		});
	});

	it('fails the mutation boundary when durable audit insertion fails', async () => {
		const cause = { code: 'P2039', message: 'private provider detail' };
		database.ownershipAuditCreate.mockRejectedValueOnce(cause);
		await expect(
			module.get(PlatformOwnerOnboardingService).create(
				{
					actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
					requestId: 'fictional-owner-invitation-request',
				},
				principal,
				ORGANIZATION_ID,
				{ displayName: 'Aline Uwase', email: 'aline@example.com' },
			),
		).rejects.toMatchObject({
			status: 503,
			cause,
			response: { code: 'OWNER_INVITATION_AUDIT_UNAVAILABLE' },
		});
	});
});
