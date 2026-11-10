import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { OrganizationStatus, PrismaService } from '@nexcoderw/akiba-db';

import { databaseErrorCode } from '../../src/common/errors/database-error-code.js';
import { organizationFailure } from '../../src/modules/platform/organizations/platform-organization-errors.js';
import { PlatformOrganizationsService } from '../../src/modules/platform/organizations/platform-organizations.service.js';
import { PlatformOrganizationMutationsService } from '../../src/modules/platform/organizations/platform-organization-mutations.service.js';
import {
	PlatformOrganizationAudit,
	UnavailableOrganizationAudit,
} from '../../src/modules/platform/organizations/platform-organization-audit.js';
import {
	createPlatformOrganizationsDatabaseFixture,
	organizationFixture,
	ORGANIZATION_ID,
	ORGANIZATION_TIME,
	organizationSessionFixture,
} from '../fixtures/platform-organizations-database.fixture.js';

import type { PlatformPrincipal } from '../../src/modules/platform/auth/platform-auth.types.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import {
	PlatformServiceAuthModule,
	PLATFORM_SERVICE_AUTH_DATABASE,
} from '../fixtures/platform-service-auth.module.js';
import type { createPlatformDashboardDatabaseFixture } from '../fixtures/platform-dashboard-database.fixture.js';

describe('organization service contracts (adapter fake, not PostgreSQL)', () => {
	let module: TestingModule;
	let principal: PlatformPrincipal;
	let database: ReturnType<typeof createPlatformOrganizationsDatabaseFixture>;
	let reads: PlatformOrganizationsService;
	let writes: PlatformOrganizationMutationsService;
	const context = {
		actorPlatformStaffId: '33333333-3333-4333-8333-333333333333',
		requestId: 'fictional-request',
	};
	const available = jest.fn<() => void>();
	const record = jest.fn<PlatformOrganizationAudit['record']>();

	beforeEach(async () => {
		database = createPlatformOrganizationsDatabaseFixture();
		available.mockReset();
		record.mockReset().mockResolvedValue(undefined);
		module = await Test.createTestingModule({
			imports: [PlatformServiceAuthModule],
			providers: [
				PlatformOrganizationsService,
				PlatformOrganizationMutationsService,
				{ provide: PrismaService, useValue: database.prisma },
				{ provide: PlatformOrganizationAudit, useValue: { assertAvailable: available, record } },
			],
		}).compile();
		principal = await module
			.get(PlatformSessionService)
			.authenticate('fictional-service-session-with-at-least-32-characters');
		reads = module.get(PlatformOrganizationsService);
		writes = module.get(PlatformOrganizationMutationsService);
	});
	afterEach(async () => {
		await module.close();
	});

	it('rejects missing and copied identities at every internal business entry point', async () => {
		for (const identity of [undefined, { ...principal }]) {
			await expect(reads.get(identity, ORGANIZATION_ID)).rejects.toMatchObject({ status: 403 });
			await expect(reads.list(identity, { limit: 20 })).rejects.toMatchObject({ status: 403 });
			await expect(
				writes.create(context, identity, { name: 'Fictional', slug: 'fictional' }),
			).rejects.toMatchObject({ status: 403 });
			await expect(
				writes.update(context, identity, ORGANIZATION_ID, { name: 'Fictional' }, ORGANIZATION_TIME),
			).rejects.toMatchObject({ status: 403 });
			for (const action of ['activation', 'suspension', 'archival'] as const) {
				await expect(
					writes.lifecycle(context, identity, ORGANIZATION_ID, action, ORGANIZATION_TIME),
				).rejects.toMatchObject({ status: 403 });
			}
		}
		expect(database.runTransaction).not.toHaveBeenCalled();
		expect(database.findUnique).not.toHaveBeenCalled();
	});

	it('rechecks revoked authority and rejects replacement audit actors before business queries', async () => {
		const authorization = module.get<ReturnType<typeof createPlatformDashboardDatabaseFixture>>(
			PLATFORM_SERVICE_AUTH_DATABASE,
		);
		authorization.sessionFindUnique.mockResolvedValue(
			organizationSessionFixture(['platform.dashboard.read']),
		);
		await expect(reads.list(principal, { limit: 20 })).rejects.toMatchObject({ status: 403 });
		await expect(
			writes.create(context, principal, { name: 'Fictional', slug: 'fictional' }),
		).rejects.toMatchObject({ status: 403 });
		await expect(
			writes.create({ ...context, actorPlatformStaffId: ORGANIZATION_ID }, principal, {
				name: 'Fictional',
				slug: 'fictional',
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(database.runTransaction).not.toHaveBeenCalled();
		expect(Object.isFrozen(principal)).toBe(true);
		expect(Object.isFrozen(principal.permissions)).toBe(true);
	});

	it('bounds pagination with a unique tie-breaker and an extra next-page probe', async () => {
		const nextId = '55555555-5555-4555-8555-555555555555';
		database.findMany.mockResolvedValue([
			{ ...organizationFixture(), id: nextId },
			{ ...organizationFixture(), id: '66666666-6666-4666-8666-666666666666' },
		]);
		const result = await reads.list(principal, {
			limit: 1,
			status: OrganizationStatus.PENDING,
			cursor: ORGANIZATION_ID,
		});
		expect(result.items).toHaveLength(1);
		expect(result.nextCursor).toBe(nextId);
		expect(database.findMany.mock.calls[0]?.[0]).toMatchObject({
			take: 2,
			skip: 1,
			cursor: { id: ORGANIZATION_ID },
			where: { status: OrganizationStatus.PENDING },
			orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
		});
	});
	it('rejects stale cursor and oversized pages without unbounded reads', async () => {
		database.findFirst.mockResolvedValue(null);
		await expect(
			reads.list(principal, { limit: 20, cursor: ORGANIZATION_ID }),
		).rejects.toMatchObject({
			status: 400,
		});
		await expect(reads.list(principal, { limit: 51 })).rejects.toMatchObject({ status: 400 });
		expect(database.findMany).not.toHaveBeenCalled();
	});
	it('excludes archived records by default but allows an explicit archived filter', async () => {
		await reads.list(principal, { limit: 20 });
		expect(database.findMany.mock.calls[0]?.[0]).toMatchObject({
			where: { status: { not: OrganizationStatus.ARCHIVED } },
		});
		await reads.list(principal, { limit: 20, status: OrganizationStatus.ARCHIVED });
		expect(database.findMany.mock.calls[1]?.[0]).toMatchObject({
			where: { status: OrganizationStatus.ARCHIVED },
		});
	});
	it('returns 404 for a missing organization', async () => {
		database.findUnique.mockResolvedValue(null);
		await expect(reads.get(principal, ORGANIZATION_ID)).rejects.toMatchObject({ status: 404 });
	});
	it.each(['P2028', 'P2021', 'P2022', 'P1010', 'P1001'])(
		'preserves safe diagnostics for list failure %s without exposing provider details',
		async (code) => {
			const cause = { code, message: 'private provider diagnostic', meta: { secret: 'private' } };
			database.runTransaction.mockRejectedValueOnce(cause);
			await expect(reads.list(principal, { limit: 20 })).rejects.toMatchObject({
				status: 503,
				cause,
			});
			expect(database.runTransaction).toHaveBeenCalledTimes(1);
			expect(database.findMany).not.toHaveBeenCalled();
			const failure = organizationFailure(cause);
			expect(databaseErrorCode(failure.cause)).toBe(code);
			expect(failure.getResponse()).toEqual({
				code: 'ORGANIZATION_PERSISTENCE_UNAVAILABLE',
				message: 'Organization persistence is unavailable',
			});
		},
	);
	it('creates pending data and appends an audit event inside the same transaction', async () => {
		await writes.create(context, principal, { name: 'Kimihurura Supplies', slug: 'kimihurura' });
		expect(database.create.mock.calls[0]?.[0]).toMatchObject({
			data: { name: 'Kimihurura Supplies', slug: 'kimihurura', status: OrganizationStatus.PENDING },
		});
		expect(record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				...context,
				action: 'create',
				previousStatus: null,
				resultingStatus: OrganizationStatus.PENDING,
				previousName: null,
				resultingName: 'Kimihurura Supplies',
			}),
		);
	});
	it('propagates audit failure from inside the transaction without returning success', async () => {
		record.mockRejectedValueOnce(new Error('audit provider unavailable'));
		await expect(
			writes.create(context, principal, { name: 'Kimihurura Supplies', slug: 'kimihurura' }),
		).rejects.toMatchObject({
			status: 503,
		});
		expect(database.runTransaction).toHaveBeenCalledTimes(1);
	});
	it('maps a database duplicate conflict without treating retry as success', async () => {
		database.create.mockRejectedValueOnce({ code: 'P2002' });
		await expect(
			writes.create(context, principal, { name: 'Kimihurura Supplies', slug: 'kimihurura' }),
		).rejects.toMatchObject({
			status: 409,
		});
		expect(record).not.toHaveBeenCalled();
	});
	it('preserves one success and one conflict for simulated simultaneous duplicate requests', async () => {
		database.create
			.mockResolvedValueOnce(organizationFixture())
			.mockRejectedValueOnce({ code: 'P2002' });
		const results = await Promise.allSettled([
			writes.create(context, principal, { name: 'Kimihurura Supplies', slug: 'kimihurura' }),
			writes.create(context, principal, { name: 'Remera Trading', slug: 'kimihurura' }),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: { status: 409 },
		});
		expect(record).toHaveBeenCalledTimes(1);
	});
	it('requires matching timestamp and status in the conditional profile update', async () => {
		database.findUnique.mockResolvedValueOnce(organizationFixture()).mockResolvedValueOnce({
			...organizationFixture(),
			name: 'Remera Trading',
		});
		await writes.update(
			context,
			principal,
			ORGANIZATION_ID,
			{ name: 'Remera Trading' },
			ORGANIZATION_TIME,
		);
		expect(database.updateMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				id: ORGANIZATION_ID,
				updatedAt: ORGANIZATION_TIME,
				status: OrganizationStatus.PENDING,
			},
			data: { name: 'Remera Trading' },
		});
		expect(record.mock.calls[0]?.[1]).toMatchObject({
			previousName: 'Kimihurura Supplies',
			resultingName: 'Remera Trading',
			changedFields: ['name'],
		});
	});
	it('rejects stale or concurrently changed rows and never appends a success audit', async () => {
		await expect(
			writes.update(context, principal, ORGANIZATION_ID, { name: 'Remera Trading' }, new Date(0)),
		).rejects.toMatchObject({ status: 412 });
		database.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			writes.lifecycle(context, principal, ORGANIZATION_ID, 'activation', ORGANIZATION_TIME),
		).rejects.toMatchObject({ status: 412 });
		expect(record).not.toHaveBeenCalled();
	});
	it('sets activation time but retains history and does not create unrelated identities', async () => {
		database.findUnique.mockResolvedValueOnce(organizationFixture()).mockResolvedValueOnce({
			...organizationFixture(),
			status: OrganizationStatus.ACTIVE,
		});
		await writes.lifecycle(context, principal, ORGANIZATION_ID, 'activation', ORGANIZATION_TIME);
		expect(database.updateMany.mock.calls[0]?.[0]).toMatchObject({
			data: {
				status: OrganizationStatus.ACTIVE,
				activatedAt: record.mock.calls[0]?.[1].occurredAt,
			},
		});
		expect(record.mock.calls[0]?.[1].resultingStatus).toBe(OrganizationStatus.ACTIVE);
		expect(database.userCount).not.toHaveBeenCalled();
	});
	it.each([OrganizationStatus.PENDING, OrganizationStatus.ACTIVE, OrganizationStatus.SUSPENDED])(
		'archives %s with a retained record and an atomic audit event',
		async (status) => {
			const previous = { ...organizationFixture(), status };
			database.findUnique.mockResolvedValueOnce(previous).mockResolvedValueOnce({
				...previous,
				status: OrganizationStatus.ARCHIVED,
			});
			await writes.lifecycle(context, principal, ORGANIZATION_ID, 'archival', ORGANIZATION_TIME);
			expect(database.updateMany.mock.calls[0]?.[0]).toMatchObject({
				where: { id: ORGANIZATION_ID, status, updatedAt: ORGANIZATION_TIME },
				data: {
					status: OrganizationStatus.ARCHIVED,
					archivedAt: record.mock.calls[0]?.[1].occurredAt,
				},
			});
			expect(record.mock.calls[0]?.[1]).toMatchObject({
				action: 'archival',
				previousStatus: status,
				resultingStatus: OrganizationStatus.ARCHIVED,
				changedFields: ['status', 'archivedAt'],
				previousName: null,
				resultingName: null,
			});
		},
	);
	it('rejects all modifications of an archived organization', async () => {
		database.findUnique.mockResolvedValue({
			...organizationFixture(),
			status: OrganizationStatus.ARCHIVED,
		});
		await expect(
			writes.update(
				context,
				principal,
				ORGANIZATION_ID,
				{ name: 'Remera Trading' },
				ORGANIZATION_TIME,
			),
		).rejects.toMatchObject({ status: 409 });
		for (const action of ['activation', 'suspension', 'archival'] as const) {
			await expect(
				writes.lifecycle(context, principal, ORGANIZATION_ID, action, ORGANIZATION_TIME),
			).rejects.toMatchObject({ status: 409 });
		}
		expect(database.updateMany).not.toHaveBeenCalled();
		expect(record).not.toHaveBeenCalled();
	});
	it('fails closed before transactions when audit persistence is absent', async () => {
		const unavailable = new UnavailableOrganizationAudit();
		available.mockImplementation(() => {
			unavailable.assertAvailable();
		});
		await expect(
			writes.create(context, principal, { name: 'Kimihurura Supplies', slug: 'kimihurura' }),
		).rejects.toMatchObject({
			status: 503,
		});
		await expect(
			writes.update(
				context,
				principal,
				ORGANIZATION_ID,
				{ name: 'Remera Trading' },
				ORGANIZATION_TIME,
			),
		).rejects.toMatchObject({ status: 503 });
		await expect(
			writes.lifecycle(context, principal, ORGANIZATION_ID, 'activation', ORGANIZATION_TIME),
		).rejects.toMatchObject({ status: 503 });
		expect(database.runTransaction).not.toHaveBeenCalled();
		expect(database.create).not.toHaveBeenCalled();
		expect(database.updateMany).not.toHaveBeenCalled();
	});
});
