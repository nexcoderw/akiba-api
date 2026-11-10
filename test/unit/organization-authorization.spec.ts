import { jest } from '@jest/globals';

import { OrganizationAuthorizationService } from '../../src/modules/owner/tenant/organization-authorization.service.js';
import {
	effectiveOrganizationPermissions,
	ORGANIZATION_PERMISSION,
} from '../../src/modules/owner/tenant/organization-permission.constants.js';
import type { TenantSecurityContext } from '../../src/modules/owner/tenant/tenant-security-context.js';

const A = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const context: TenantSecurityContext = Object.freeze({
	principal: 'organization',
	organizationId: A,
	organizationSlug: 'example',
	membershipId: MEMBER,
	userId: USER,
	sessionId: SESSION,
	assurance: 'AAL1',
	expiresAt: Date.now() + 60_000,
	requestId: 'req_55555555-5555-4555-8555-555555555555',
	resourceScope: { organizationId: A, branchIds: [] },
});

function role(key: string, isSystem: boolean, isActive: boolean, keys: string[]) {
	return {
		organizationRole: {
			key,
			isSystem,
			isActive,
			permissions: keys.map((permission) => ({ organizationPermission: { key: permission } })),
		},
	};
}

describe('organization authorization', () => {
	it('unions active ordinary grants, drops unknown mappings and never promotes a custom owner lookalike', () => {
		const grants = effectiveOrganizationPermissions([
			role('custom.reader', false, true, [
				ORGANIZATION_PERMISSION.membersRead,
				'invented.permission',
			]),
			role('custom.writer', false, true, [
				ORGANIZATION_PERMISSION.membersRead,
				ORGANIZATION_PERMISSION.rolesSystem,
			]),
			role('custom.inactive', false, false, [ORGANIZATION_PERMISSION.membersManage]),
			role('owner', false, true, [ORGANIZATION_PERMISSION.rolesSystem]),
			role('administrator', true, true, [ORGANIZATION_PERMISSION.membersManage]),
		]);
		expect([...grants]).toEqual([ORGANIZATION_PERMISSION.membersRead]);
		expect(effectiveOrganizationPermissions([role('owner', true, true, [])])).toEqual(
			new Set(Object.values(ORGANIZATION_PERMISSION)),
		);
	});

	it('rechecks the current session and selected membership on every evaluation', async () => {
		const session = jest.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue({
			authenticatedAt: new Date('2026-01-01'),
			assurance: 'AAL1',
			mfaVerifiedAt: null,
			user: { passwordCredential: { disabledAt: null, passwordChangedAt: new Date('2025-01-01') } },
		});
		const membership = jest
			.fn<(args: unknown) => Promise<unknown>>()
			.mockResolvedValue({
				roles: [role('custom.reader', false, true, [ORGANIZATION_PERMISSION.membersRead])],
			});
		const transaction = {
			ownerSession: { findFirst: session },
			organizationMembership: { findFirst: membership },
		};
		const access = { assert: jest.fn() };
		const service = new OrganizationAuthorizationService(
			access as unknown as ConstructorParameters<typeof OrganizationAuthorizationService>[0],
			{} as ConstructorParameters<typeof OrganizationAuthorizationService>[1],
		);
		const client = transaction as unknown as Parameters<typeof service.effectiveInTransaction>[0];
		expect(
			(await service.effectiveInTransaction(client, context)).has(
				ORGANIZATION_PERMISSION.membersRead,
			),
		).toBe(true);
		membership.mockResolvedValue({ roles: [role('owner', true, true, [])] });
		const ownerGrants = await service.effectiveInTransaction(client, context);
		expect(ownerGrants.has(ORGANIZATION_PERMISSION.membersRead)).toBe(true);
		expect(ownerGrants.has(ORGANIZATION_PERMISSION.rolesSystem)).toBe(false);
		membership.mockResolvedValue(null);
		await expect(service.effectiveInTransaction(client, context)).rejects.toMatchObject({
			publicCode: 'ORGANIZATION_ACCESS_DENIED',
		});
		expect(session).toHaveBeenCalledTimes(3);
		expect(membership.mock.calls[0]?.[0]).toMatchObject({
			where: {
				organizationId: A,
				id: MEMBER,
				userId: USER,
			},
		});
	});

	it('denies unknown permissions and unverified branch scope', async () => {
		const run = async (_scope: unknown, operation: (transaction: unknown) => Promise<unknown>) =>
			operation({});
		const service = new OrganizationAuthorizationService(
			{ assert: () => undefined } as unknown as ConstructorParameters<
				typeof OrganizationAuthorizationService
			>[0],
			{ run } as unknown as ConstructorParameters<typeof OrganizationAuthorizationService>[1],
		);
		const grants = new Set([ORGANIZATION_PERMISSION.membersRead]);
		jest.spyOn(service, 'effectiveInTransaction').mockResolvedValue(grants);
		await expect(
			service.hasOrganizationPermission(context, 'organization.unknown', { kind: 'organization' }),
		).resolves.toBe(false);
		await expect(
			service.hasOrganizationPermission(context, ORGANIZATION_PERMISSION.membersRead, {
				kind: 'branch',
				branchId: '66666666-6666-4666-8666-666666666666',
			}),
		).resolves.toBe(false);
		await expect(
			service.hasOrganizationPermission(context, ORGANIZATION_PERMISSION.membersRead, {
				kind: 'organization',
			}),
		).resolves.toBe(true);
		await expect(
			service.hasOrganizationPermission(context, ORGANIZATION_PERMISSION.membersRead, {
				kind: 'warehouse',
			} as unknown as Parameters<typeof service.hasOrganizationPermission>[2]),
		).resolves.toBe(false);
	});
});
