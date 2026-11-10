import { jest } from '@jest/globals';
import { OrganizationMembershipStatus } from '@nexcoderw/akiba-db';

import { OrganizationAccessManagementService } from '../../src/modules/owner/tenant/organization-access-management.service.js';
import { ORGANIZATION_PERMISSION } from '../../src/modules/owner/tenant/organization-permission.constants.js';
import type { TenantSecurityContext } from '../../src/modules/owner/tenant/tenant-security-context.js';

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = '22222222-2222-4222-8222-222222222222';
const context: TenantSecurityContext = {
	principal: 'organization',
	organizationId: ORGANIZATION,
	organizationSlug: 'example',
	membershipId: MEMBERSHIP,
	userId: '33333333-3333-4333-8333-333333333333',
	sessionId: '44444444-4444-4444-8444-444444444444',
	assurance: 'AAL1',
	expiresAt: Date.now() + 60_000,
	requestId: 'req_55555555-5555-4555-8555-555555555555',
	resourceScope: { organizationId: ORGANIZATION, branchIds: [] },
};

describe('internal organization access management', () => {
	const roleCreate = jest.fn<(args: unknown) => Promise<{ id: string }>>().mockResolvedValue({
		id: '66666666-6666-4666-8666-666666666666',
	});
	const permissionCreate = jest
		.fn<(args: unknown) => Promise<unknown>>()
		.mockResolvedValue({ count: 1 });
	const auditCreate = jest.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue({});
	const transaction = {
		$queryRaw: jest.fn<() => Promise<unknown>>().mockResolvedValue([{ id: ORGANIZATION }]),
		organizationPermission: {
			findMany: jest
				.fn<() => Promise<unknown>>()
				.mockResolvedValue([
					{ id: '77777777-7777-4777-8777-777777777777', key: ORGANIZATION_PERMISSION.membersRead },
				]),
		},
		organizationRole: { create: roleCreate },
		organizationRolePermission: { createMany: permissionCreate },
		organizationMembership: { findFirst: jest.fn<(args: unknown) => Promise<unknown>>() },
		organizationAuthorizationAuditEvent: { create: auditCreate },
	};
	const grants = new Set(Object.values(ORGANIZATION_PERMISSION));
	const access = {
		assert: jest.fn(),
		resourceWhere: (_context: TenantSecurityContext, id: string) => ({
			organizationId: ORGANIZATION,
			id,
		}),
	};
	const authorization = {
		effectiveInTransaction: jest.fn<() => Promise<ReadonlySet<string>>>().mockResolvedValue(grants),
	};
	const run = jest
		.fn<
			(
				scope: unknown,
				callback: (client: typeof transaction) => Promise<unknown>,
				options: unknown,
			) => Promise<unknown>
		>()
		.mockImplementation((_scope, callback) => callback(transaction));
	const service = new OrganizationAccessManagementService(
		access as unknown as ConstructorParameters<typeof OrganizationAccessManagementService>[0],
		authorization as unknown as ConstructorParameters<
			typeof OrganizationAccessManagementService
		>[1],
		{ run } as unknown as ConstructorParameters<typeof OrganizationAccessManagementService>[2],
	);

	beforeEach(() => jest.clearAllMocks());

	it('denies owner-only delegation even to a role creator with broad grants', async () => {
		await expect(
			service.createCustomRole(context, {
				key: 'custom.reader',
				name: 'Reader',
				permissionKeys: [ORGANIZATION_PERMISSION.rolesSystem],
			}),
		).rejects.toMatchObject({ publicCode: 'ORGANIZATION_ACCESS_DENIED' });
		expect(roleCreate).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledWith({ organizationId: ORGANIZATION }, expect.any(Function), {
			maxWait: 5000,
			timeout: 10000,
		});
	});

	it('writes scoped role, permission mapping and actor audit in one transaction', async () => {
		await expect(
			service.createCustomRole(context, {
				key: 'custom.reader',
				name: 'Reader',
				permissionKeys: [ORGANIZATION_PERMISSION.membersRead],
			}),
		).resolves.toBe('66666666-6666-4666-8666-666666666666');
		expect(roleCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { organizationId: ORGANIZATION, isSystem: false, isActive: true },
		});
		expect(permissionCreate.mock.calls[0]?.[0]).toMatchObject({
			data: [{ organizationId: ORGANIZATION }],
		});
		expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
			data: {
				organizationId: ORGANIZATION,
				actorMembershipId: MEMBERSHIP,
				action: 'role_created',
			},
		});
	});

	it('rejects self assignment before any transaction starts', async () => {
		await expect(
			service.changeAssignment(context, {
				membershipId: MEMBERSHIP,
				roleId: '66666666-6666-4666-8666-666666666666',
				expectedMembershipVersion: 1,
				assign: true,
			}),
		).rejects.toMatchObject({ publicCode: 'ORGANIZATION_ACCESS_DENIED' });
		expect(run).not.toHaveBeenCalled();
	});

	it('refuses to suspend a protected owner membership', async () => {
		transaction.organizationMembership.findFirst.mockResolvedValue({
			id: '88888888-8888-4888-8888-888888888888',
			status: OrganizationMembershipStatus.ACTIVE,
			user: { status: 'ACTIVE', emailVerifiedAt: new Date() },
			roles: [
				{ organizationRole: { key: 'owner', isSystem: true, isActive: true, permissions: [] } },
			],
		});
		await expect(
			service.changeMembershipStatus(context, {
				membershipId: '88888888-8888-4888-8888-888888888888',
				expectedVersion: 1,
				status: OrganizationMembershipStatus.SUSPENDED,
			}),
		).rejects.toMatchObject({ publicCode: 'ORGANIZATION_ACCESS_DENIED' });
		expect(auditCreate).not.toHaveBeenCalled();
	});
});
