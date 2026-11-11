import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PlatformStaffStatus, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformOwnerBootstrapService } from '../../src/modules/platform/bootstrap/platform-owner-bootstrap.service.js';

describe('PlatformOwnerBootstrapService', () => {
	const queryRaw = jest.fn<() => Promise<unknown>>();
	const staffCount = jest.fn<() => Promise<number>>();
	const userFindUnique = jest.fn<() => Promise<unknown>>();
	const userCreate = jest.fn<() => Promise<unknown>>();
	const roleFindUnique = jest.fn<() => Promise<unknown>>();
	const roleCreate = jest.fn<() => Promise<unknown>>();
	const permissionFindUnique = jest.fn<() => Promise<unknown>>();
	const permissionCreate = jest.fn<() => Promise<unknown>>();
	const rolePermissionUpsert = jest.fn<() => Promise<unknown>>();
	const staffRoleCreate = jest.fn<() => Promise<unknown>>();
	const identityAuditCreate = jest.fn<(input: unknown) => Promise<unknown>>();
	const transaction = {
		$queryRaw: queryRaw,
		platformStaff: { count: staffCount },
		user: { findUnique: userFindUnique, create: userCreate },
		platformRole: { findUnique: roleFindUnique, create: roleCreate },
		platformPermission: { findUnique: permissionFindUnique, create: permissionCreate },
		platformRolePermission: { upsert: rolePermissionUpsert },
		platformStaffRole: { create: staffRoleCreate },
		identitySecurityAuditEvent: { create: identityAuditCreate },
	};
	type TransactionOperation = (client: typeof transaction) => Promise<unknown>;
	const runTransaction = jest.fn((operation: TransactionOperation) => operation(transaction));
	let service: PlatformOwnerBootstrapService;

	beforeAll(async () => {
		const config = new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({
				NODE_ENV: 'development',
				DATABASE_URL:
					'postgresql://neondb_owner:fictional@development.example.com/neondb?sslmode=require',
				PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true',
			}),
		);
		const module = await Test.createTestingModule({
			providers: [
				PlatformOwnerBootstrapService,
				{ provide: ConfigService, useValue: config },
				{ provide: PrismaService, useValue: { $transaction: runTransaction } },
			],
		}).compile();
		service = module.get(PlatformOwnerBootstrapService);
	});

	beforeEach(() => {
		jest.clearAllMocks();
		queryRaw.mockReset();
		queryRaw
			.mockResolvedValueOnce([{ acquired: true }])
			.mockResolvedValue([
				{ databaseName: 'neondb', databaseRole: 'neondb_owner', sessionRole: 'neondb_owner' },
			]);
		staffCount.mockResolvedValue(0);
		userFindUnique.mockResolvedValue(null);
		roleFindUnique.mockResolvedValue(null);
		roleCreate.mockResolvedValue({ id: 'owner-role-id' });
		permissionFindUnique.mockResolvedValue(null);
		permissionCreate.mockResolvedValue({ id: 'dashboard-permission-id' });
		rolePermissionUpsert.mockResolvedValue({});
		userCreate.mockResolvedValue({
			id: 'user-id',
			identityVersion: 1,
			platformStaff: { id: 'staff-id' },
		});
		staffRoleCreate.mockResolvedValue({});
		identityAuditCreate.mockResolvedValue({ id: 'audit-id' });
	});

	it('identifies the selected target without exposing credentials', () => {
		expect(service.getTarget()).toEqual({
			environment: 'development',
			databaseHost: 'development.example.com',
			databaseName: 'neondb',
			databaseRole: 'neondb_owner',
		});
	});

	it('atomically reserves a pending owner without a password, MFA factor or session', async () => {
		await expect(
			service.initialize({ email: 'Owner@Example.com', displayName: 'Fictional Owner' }),
		).resolves.toBeUndefined();
		expect(userCreate).toHaveBeenCalledWith({
			data: {
				email: 'owner@example.com',
				displayName: 'Fictional Owner',
				status: UserStatus.PENDING,
				platformStaff: { create: { status: PlatformStaffStatus.PENDING } },
			},
			select: { id: true, identityVersion: true, platformStaff: { select: { id: true } } },
		});
		expect(staffRoleCreate).toHaveBeenCalledWith({
			data: { platformStaffId: 'staff-id', platformRoleId: 'owner-role-id' },
		});
		expect(identityAuditCreate).toHaveBeenCalledTimes(1);
		expect(identityAuditCreate.mock.calls[0]?.[0]).toMatchObject({
			data: {
				actorKind: 'bootstrap',
				actorPlatformStaffId: 'staff-id',
				userId: 'user-id',
				action: 'identity_created',
			},
			select: { id: true },
		});
	});

	it('rejects a second reservation even if the existing owner is pending or disabled', async () => {
		staffCount.mockResolvedValue(1);
		await expect(
			service.initialize({ email: 'owner@example.com', displayName: 'Fictional Owner' }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_INITIALIZED' });
		expect(userCreate).not.toHaveBeenCalled();
	});

	it('rejects a concurrent reservation before reading owner state', async () => {
		queryRaw.mockReset().mockResolvedValue([{ acquired: false }]);
		await expect(
			service.initialize({ email: 'owner@example.com', displayName: 'Fictional Owner' }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_CONCURRENT_OPERATION' });
		expect(staffCount).not.toHaveBeenCalled();
	});

	it('rejects a different connected database identity before writes', async () => {
		queryRaw
			.mockReset()
			.mockResolvedValueOnce([{ acquired: true }])
			.mockResolvedValueOnce([
				{ databaseName: 'other', databaseRole: 'neondb_owner', sessionRole: 'neondb_owner' },
			]);
		await expect(
			service.initialize({ email: 'owner@example.com', displayName: 'Fictional Owner' }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_UNSAFE_DATABASE' });
		expect(userCreate).not.toHaveBeenCalled();
	});

	it('does not take over an existing global identity', async () => {
		userFindUnique.mockResolvedValue({ id: 'existing-user-id' });
		await expect(
			service.initialize({ email: 'owner@example.com', displayName: 'Fictional Owner' }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_IDENTITY_CONFLICT' });
		expect(userCreate).not.toHaveBeenCalled();
	});

	it('rejects malformed identities and names before connecting', async () => {
		await expect(
			service.initialize({ email: 'invalid', displayName: 'Fictional Owner' }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_INVALID_INPUT' });
		await expect(
			service.initialize({ email: 'owner@example.com', displayName: '\u0000Unsafe' }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_INVALID_INPUT' });
		expect(runTransaction).not.toHaveBeenCalled();
	});

	it('blocks activation regardless of an operator assertion', () => {
		expect(() => service.activate()).toThrow(
			'Owner activation requires a verified mailbox challenge',
		);
		expect(runTransaction).not.toHaveBeenCalled();
	});
});
