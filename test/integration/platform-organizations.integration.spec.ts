import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { AppModule } from '../../src/app.module.js';
import {
	PlatformOrganizationAudit,
	DurableOrganizationAudit,
} from '../../src/modules/platform/organizations/platform-organization-audit.js';
import { PlatformOrganizationsController } from '../../src/modules/platform/organizations/platform-organizations.controller.js';
import { PlatformOrganizationMutationsService } from '../../src/modules/platform/organizations/platform-organization-mutations.service.js';
import {
	createPlatformOrganizationsDatabaseFixture,
	ORGANIZATION_ID,
	organizationSessionFixture,
} from '../fixtures/platform-organizations-database.fixture.js';

import type { PlatformPrincipal } from '../../src/modules/platform/auth/platform-auth.types.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PLATFORM_PERMISSION } from '../../src/modules/platform/auth/platform-permission.constants.js';

describe('organization module integration (adapter fake; no live PostgreSQL)', () => {
	let module: TestingModule;
	let principal: PlatformPrincipal;
	const database = createPlatformOrganizationsDatabaseFixture();
	beforeAll(async () => {
		module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue(database.prisma)
			.compile();
	});
	beforeEach(async () => {
		database.sessionFindUnique.mockResolvedValue(organizationSessionFixture(Object.values(PLATFORM_PERMISSION)));
		principal = await module.get(PlatformSessionService).authenticate(
			'fictional-integration-session-with-at-least-32-characters',
		);
		database.runTransaction.mockClear();
	});

	afterAll(async () => {
		await module.close();
	});

	it('reuses the existing database provider and registers the durable audit provider', () => {
		expect(module.get(PrismaService)).toBe(database.prisma);
		expect(module.get(PlatformOrganizationAudit)).toBeInstanceOf(DurableOrganizationAudit);
	});
	it('resolves the registered controller and explicit read contract', async () => {
		const controller = module.get(PlatformOrganizationsController);
		expect(await controller.list({ limit: 20 }, { platformPrincipal: principal })).toMatchObject({
			items: [{ id: ORGANIZATION_ID, name: 'Kimihurura Supplies' }],
			nextCursor: null,
		});
	});
	it('writes an allowlisted audit event through the mutation transaction', async () => {
		const occurredAt: unknown = expect.any(Date);
		await expect(
			module.get(PlatformOrganizationMutationsService).create(
				{
					actorPlatformStaffId: '33333333-3333-4333-8333-333333333333',
					requestId: 'fictional-request',
				},
				principal,
				{ name: 'Kimihurura Supplies', slug: 'kimihurura' },
			),
		).resolves.toMatchObject({ id: ORGANIZATION_ID });
		expect(database.auditCreate).toHaveBeenCalledWith({
			data: {
				organizationId: ORGANIZATION_ID,
				actorPlatformStaffId: '33333333-3333-4333-8333-333333333333',
				requestId: 'fictional-request',
				action: 'CREATE',
				occurredAt,
				previousStatus: null,
				resultingStatus: 'PENDING',
				changedFields: ['name', 'slug', 'status'],
				previousName: null,
				resultingName: 'Kimihurura Supplies',
			},
			select: { id: true },
		});
	});
	it('rejects the transaction when the durable insert fails and preserves protected diagnostics', async () => {
		const cause = { code: 'P2039', message: 'private provider detail' };
		database.auditCreate.mockRejectedValueOnce(cause);
		await expect(
			module.get(PlatformOrganizationMutationsService).create(
				{
					actorPlatformStaffId: '33333333-3333-4333-8333-333333333333',
					requestId: 'fictional-request',
				},
				principal,
				{ name: 'Kimihurura Supplies', slug: 'kimihurura' },
			),
		).rejects.toMatchObject({
			status: 503,
			cause,
			response: { code: 'ORGANIZATION_AUDIT_UNAVAILABLE' },
		});
	});
});
