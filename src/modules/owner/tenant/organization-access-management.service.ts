import { Injectable } from '@nestjs/common';
import {
	OrganizationMembershipStatus,
	type Prisma,
	TenantTransactionService,
	UserStatus,
} from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import { databaseErrorCode } from '../../../common/errors/database-error-code.js';
import {
	OWNER_ONLY_ORGANIZATION_PERMISSIONS,
	ORGANIZATION_PERMISSION,
	isOrganizationPermission,
	type OrganizationPermission,
} from './organization-permission.constants.js';
import { OrganizationAuthorizationService } from './organization-authorization.service.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import type { TenantSecurityContext } from './tenant-security-context.js';

const CUSTOM_KEY = /^custom\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED_NAMES = new Set([
	'owner',
	'organization owner',
	'admin',
	'administrator',
	'organization administrator',
	'superadmin',
	'platform owner',
]);

type MutableTransaction = Prisma.TransactionClient;
type AuditAction =
	| 'role_created'
	| 'role_details_changed'
	| 'role_permissions_changed'
	| 'role_disabled'
	| 'role_assigned'
	| 'role_revoked'
	| 'membership_suspended'
	| 'membership_reactivated'
	| 'membership_revoked';

/** Internal-only workflows. No controller exposes role or membership writes. */
@Injectable()
export class OrganizationAccessManagementService {
	constructor(
		private readonly access: TenantAuthorizationService,
		private readonly authorization: OrganizationAuthorizationService,
		private readonly transactions: TenantTransactionService,
	) {}

	private async run<T>(
		context: TenantSecurityContext,
		permission: OrganizationPermission,
		operation: (
			transaction: MutableTransaction,
			grants: ReadonlySet<OrganizationPermission>,
		) => Promise<T>,
	): Promise<T> {
		this.access.assert(context);
		try {
			return await this.transactions.run(
				{ organizationId: context.organizationId },
				async (transaction) => {
					// One lock order serializes tenant authorization changes and protects the live grant check.
					const organization = await transaction.$queryRaw<{ id: string }[]>`
				SELECT id FROM public.organizations
				WHERE id = ${context.organizationId}::uuid AND status = 'active' FOR UPDATE
			`;
					if (organization.length !== 1) throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
					const grants = await this.authorization.effectiveInTransaction(transaction, context);
					if (!grants.has(permission)) throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
					return operation(transaction, grants);
				},
				{ maxWait: 5000, timeout: 10000 },
			);
		} catch (error: unknown) {
			if (error instanceof ApiProblemException) throw error;
			const code = databaseErrorCode(error);
			if (code === 'P2002' || code === 'P2034')
				throw new ApiProblemException('RESOURCE_CONFLICT', [], error);
			if (code === 'P2003') throw new ApiProblemException('RESOURCE_NOT_FOUND', [], error);
			throw error;
		}
	}

	private validatedGrants(
		requested: readonly string[],
		actor: ReadonlySet<OrganizationPermission>,
	): OrganizationPermission[] {
		if (requested.length > 32 || new Set(requested).size !== requested.length) {
			throw new ApiProblemException('VALIDATION_FAILED');
		}
		const result: OrganizationPermission[] = [];
		for (const key of requested) {
			if (
				!isOrganizationPermission(key) ||
				OWNER_ONLY_ORGANIZATION_PERMISSIONS.has(key) ||
				!actor.has(key)
			) {
				throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
			}
			result.push(key);
		}
		return result;
	}

	private assertVersion(value: number): void {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new ApiProblemException('VALIDATION_FAILED');
	}

	private assertRoleDetails(name: string, description?: string | null): void {
		if (
			name.trim() !== name ||
			name.length < 1 ||
			name.length > 120 ||
			RESERVED_NAMES.has(name.toLocaleLowerCase('en')) ||
			(description !== undefined &&
				description !== null &&
				(description.trim().length === 0 || description.length > 500))
		) {
			throw new ApiProblemException('VALIDATION_FAILED');
		}
	}

	private async catalog(transaction: MutableTransaction, keys: readonly OrganizationPermission[]) {
		const rows = await transaction.organizationPermission.findMany({
			where: { key: { in: [...keys] } },
			select: { id: true, key: true },
		});
		if (rows.length !== keys.length) throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
		return rows;
	}

	private async audit(
		transaction: MutableTransaction,
		context: TenantSecurityContext,
		action: AuditAction,
		targetMembershipId?: string,
		targetRoleId?: string,
	): Promise<void> {
		await transaction.organizationAuthorizationAuditEvent.create({
			data: {
				organizationId: context.organizationId,
				actorMembershipId: context.membershipId,
				actorUserId: context.userId,
				targetMembershipId,
				targetRoleId,
				action,
				requestId: context.requestId,
			},
		});
	}

	async createCustomRole(
		context: TenantSecurityContext,
		input: Readonly<{
			key: string;
			name: string;
			description?: string;
			permissionKeys: readonly string[];
		}>,
	): Promise<string> {
		this.assertRoleDetails(input.name, input.description);
		if (!CUSTOM_KEY.test(input.key) || input.key.length > 63) {
			throw new ApiProblemException('VALIDATION_FAILED');
		}
		return this.run(context, ORGANIZATION_PERMISSION.rolesCreate, async (transaction, grants) => {
			const keys = this.validatedGrants(input.permissionKeys, grants);
			const permissions = await this.catalog(transaction, keys);
			const role = await transaction.organizationRole.create({
				data: {
					organizationId: context.organizationId,
					key: input.key,
					name: input.name,
					description: input.description,
					isSystem: false,
					isActive: true,
				},
			});
			if (permissions.length > 0)
				await transaction.organizationRolePermission.createMany({
					data: permissions.map((permission) => ({
						organizationId: context.organizationId,
						organizationRoleId: role.id,
						organizationPermissionId: permission.id,
					})),
				});
			await this.audit(transaction, context, 'role_created', undefined, role.id);
			return role.id;
		});
	}

	async updateCustomRoleDetails(
		context: TenantSecurityContext,
		roleId: string,
		expectedVersion: number,
		input: Readonly<{ name: string; description?: string | null }>,
	): Promise<void> {
		this.assertVersion(expectedVersion);
		this.assertRoleDetails(input.name, input.description);
		const roleWhere = this.access.resourceWhere(context, roleId);
		await this.run(context, ORGANIZATION_PERMISSION.rolesUpdate, async (transaction, grants) => {
			const role = await transaction.organizationRole.findFirst({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
					authorizationVersion: expectedVersion,
				},
				select: {
					id: true,
					memberships: {
						where: { organizationMembershipId: context.membershipId },
						select: { organizationMembershipId: true },
					},
					permissions: { select: { organizationPermission: { select: { key: true } } } },
				},
			});
			if (role === null) throw new ApiProblemException('RESOURCE_NOT_FOUND');
			if (role.memberships.length > 0) throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
			for (const mapping of role.permissions)
				if (!grants.has(mapping.organizationPermission.key as OrganizationPermission)) {
					throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
				}
			const updated = await transaction.organizationRole.updateMany({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
					authorizationVersion: expectedVersion,
				},
				data: {
					name: input.name,
					description: input.description,
					authorizationVersion: { increment: 1 },
				},
			});
			if (updated.count !== 1) throw new ApiProblemException('PRECONDITION_FAILED');
			await this.audit(transaction, context, 'role_details_changed', undefined, role.id);
		});
	}

	async replaceCustomRolePermissions(
		context: TenantSecurityContext,
		roleId: string,
		expectedVersion: number,
		permissionKeys: readonly string[],
	): Promise<void> {
		this.assertVersion(expectedVersion);
		const roleWhere = this.access.resourceWhere(context, roleId);
		await this.run(context, ORGANIZATION_PERMISSION.rolesUpdate, async (transaction, grants) => {
			const role = await transaction.organizationRole.findFirst({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
					authorizationVersion: expectedVersion,
				},
				select: {
					id: true,
					memberships: {
						where: { organizationMembershipId: context.membershipId },
						select: { organizationMembershipId: true },
					},
					permissions: { select: { organizationPermission: { select: { key: true } } } },
				},
			});
			if (role === null) throw new ApiProblemException('RESOURCE_NOT_FOUND');
			if (role.memberships.length > 0) throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
			// An actor cannot indirectly strip or replace a grant they cannot delegate.
			for (const mapping of role.permissions)
				if (!grants.has(mapping.organizationPermission.key as OrganizationPermission)) {
					throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
				}
			const keys = this.validatedGrants(permissionKeys, grants);
			const permissions = await this.catalog(transaction, keys);
			const updated = await transaction.organizationRole.updateMany({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
					authorizationVersion: expectedVersion,
				},
				data: { authorizationVersion: { increment: 1 } },
			});
			if (updated.count !== 1) throw new ApiProblemException('PRECONDITION_FAILED');
			await transaction.organizationRolePermission.deleteMany({
				where: {
					organizationId: context.organizationId,
					organizationRoleId: role.id,
				},
			});
			if (permissions.length > 0)
				await transaction.organizationRolePermission.createMany({
					data: permissions.map((permission) => ({
						organizationId: context.organizationId,
						organizationRoleId: role.id,
						organizationPermissionId: permission.id,
					})),
				});
			await transaction.ownerSession.updateMany({
				where: {
					organizationId: context.organizationId,
					membership: { roles: { some: { organizationRoleId: role.id } } },
					revokedAt: null,
				},
				data: { revokedAt: new Date(), revocationReason: 'membership_change' },
			});
			await this.audit(transaction, context, 'role_permissions_changed', undefined, role.id);
		});
	}

	async disableCustomRole(
		context: TenantSecurityContext,
		roleId: string,
		expectedVersion: number,
	): Promise<void> {
		this.assertVersion(expectedVersion);
		const roleWhere = this.access.resourceWhere(context, roleId);
		await this.run(context, ORGANIZATION_PERMISSION.rolesUpdate, async (transaction, grants) => {
			const role = await transaction.organizationRole.findFirst({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
					authorizationVersion: expectedVersion,
				},
				select: {
					id: true,
					permissions: { select: { organizationPermission: { select: { key: true } } } },
				},
			});
			if (role === null) throw new ApiProblemException('RESOURCE_NOT_FOUND');
			for (const mapping of role.permissions)
				if (!grants.has(mapping.organizationPermission.key as OrganizationPermission)) {
					throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
				}
			const updated = await transaction.organizationRole.updateMany({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
					authorizationVersion: expectedVersion,
				},
				data: { isActive: false, authorizationVersion: { increment: 1 } },
			});
			if (updated.count !== 1) throw new ApiProblemException('PRECONDITION_FAILED');
			await transaction.ownerSession.updateMany({
				where: {
					organizationId: context.organizationId,
					membership: { roles: { some: { organizationRoleId: role.id } } },
					revokedAt: null,
				},
				data: { revokedAt: new Date(), revocationReason: 'membership_change' },
			});
			await this.audit(transaction, context, 'role_disabled', undefined, role.id);
		});
	}

	async changeAssignment(
		context: TenantSecurityContext,
		input: Readonly<{
			membershipId: string;
			roleId: string;
			expectedMembershipVersion: number;
			assign: boolean;
		}>,
	): Promise<void> {
		this.assertVersion(input.expectedMembershipVersion);
		const membershipWhere = this.access.resourceWhere(context, input.membershipId);
		const roleWhere = this.access.resourceWhere(context, input.roleId);
		if (input.membershipId === context.membershipId)
			throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
		await this.run(context, ORGANIZATION_PERMISSION.rolesAssign, async (transaction, grants) => {
			const membership = await transaction.organizationMembership.findFirst({
				where: {
					...membershipWhere,
					authorizationVersion: input.expectedMembershipVersion,
					status: OrganizationMembershipStatus.ACTIVE,
				},
				select: {
					id: true,
					roles: {
						where: { organizationRole: { isSystem: true } },
						select: { organizationRoleId: true },
					},
				},
			});
			if (membership === null || membership.roles.length > 0)
				throw new ApiProblemException('RESOURCE_NOT_FOUND');
			const role = await transaction.organizationRole.findFirst({
				where: {
					...roleWhere,
					isSystem: false,
					isActive: true,
				},
				select: {
					id: true,
					permissions: { select: { organizationPermission: { select: { key: true } } } },
				},
			});
			if (role === null) throw new ApiProblemException('RESOURCE_NOT_FOUND');
			for (const mapping of role.permissions)
				if (!grants.has(mapping.organizationPermission.key as OrganizationPermission)) {
					throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
				}
			const existing = await transaction.organizationMembershipRole.findUnique({
				where: {
					organizationId_organizationMembershipId_organizationRoleId: {
						organizationId: context.organizationId,
						organizationMembershipId: membership.id,
						organizationRoleId: role.id,
					},
				},
			});
			if (Boolean(existing) === input.assign) throw new ApiProblemException('RESOURCE_CONFLICT');
			const updated = await transaction.organizationMembership.updateMany({
				where: {
					...membershipWhere,
					authorizationVersion: input.expectedMembershipVersion,
					status: OrganizationMembershipStatus.ACTIVE,
				},
				data: { authorizationVersion: { increment: 1 } },
			});
			if (updated.count !== 1) throw new ApiProblemException('PRECONDITION_FAILED');
			if (input.assign)
				await transaction.organizationMembershipRole.create({
					data: {
						organizationId: context.organizationId,
						organizationMembershipId: membership.id,
						organizationRoleId: role.id,
					},
				});
			else
				await transaction.organizationMembershipRole.delete({
					where: {
						organizationId_organizationMembershipId_organizationRoleId: {
							organizationId: context.organizationId,
							organizationMembershipId: membership.id,
							organizationRoleId: role.id,
						},
					},
				});
			await transaction.ownerSession.updateMany({
				where: {
					organizationId: context.organizationId,
					membershipId: membership.id,
					revokedAt: null,
				},
				data: { revokedAt: new Date(), revocationReason: 'membership_change' },
			});
			await this.audit(
				transaction,
				context,
				input.assign ? 'role_assigned' : 'role_revoked',
				membership.id,
				role.id,
			);
		});
	}

	async changeMembershipStatus(
		context: TenantSecurityContext,
		input: Readonly<{
			membershipId: string;
			expectedVersion: number;
			status:
				| typeof OrganizationMembershipStatus.SUSPENDED
				| typeof OrganizationMembershipStatus.ACTIVE
				| typeof OrganizationMembershipStatus.REVOKED;
		}>,
	): Promise<void> {
		this.assertVersion(input.expectedVersion);
		if (
			![
				OrganizationMembershipStatus.ACTIVE,
				OrganizationMembershipStatus.SUSPENDED,
				OrganizationMembershipStatus.REVOKED,
			].includes(input.status)
		) {
			throw new ApiProblemException('VALIDATION_FAILED');
		}
		const targetWhere = this.access.resourceWhere(context, input.membershipId);
		if (input.membershipId === context.membershipId)
			throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
		await this.run(context, ORGANIZATION_PERMISSION.membersManage, async (transaction, grants) => {
			const target = await transaction.organizationMembership.findFirst({
				where: {
					...targetWhere,
					authorizationVersion: input.expectedVersion,
				},
				select: {
					id: true,
					status: true,
					user: { select: { status: true, emailVerifiedAt: true } },
					roles: {
						select: {
							organizationRole: {
								select: {
									key: true,
									isSystem: true,
									isActive: true,
									permissions: { select: { organizationPermission: { select: { key: true } } } },
								},
							},
						},
					},
				},
			});
			if (target === null) throw new ApiProblemException('RESOURCE_NOT_FOUND');
			for (const assignment of target.roles) {
				const role = assignment.organizationRole;
				if (role.isSystem) throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
				if (!role.isActive) continue;
				for (const mapping of role.permissions) {
					const key = mapping.organizationPermission.key;
					if (!isOrganizationPermission(key) || !grants.has(key)) {
						throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
					}
				}
			}
			const permitted =
				(target.status === OrganizationMembershipStatus.ACTIVE &&
					(input.status === OrganizationMembershipStatus.SUSPENDED ||
						input.status === OrganizationMembershipStatus.REVOKED)) ||
				(target.status === OrganizationMembershipStatus.SUSPENDED &&
					(input.status === OrganizationMembershipStatus.ACTIVE ||
						input.status === OrganizationMembershipStatus.REVOKED));
			if (!permitted) throw new ApiProblemException('RESOURCE_CONFLICT');
			if (
				input.status === OrganizationMembershipStatus.ACTIVE &&
				(target.user.status !== UserStatus.ACTIVE || target.user.emailVerifiedAt === null)
			) {
				throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
			}
			const now = new Date();
			const updated = await transaction.organizationMembership.updateMany({
				where: {
					...targetWhere,
					status: target.status,
					authorizationVersion: input.expectedVersion,
				},
				data: {
					status: input.status,
					authorizationVersion: { increment: 1 },
					activatedAt: input.status === OrganizationMembershipStatus.ACTIVE ? now : undefined,
					suspendedAt: input.status === OrganizationMembershipStatus.SUSPENDED ? now : undefined,
					revokedAt: input.status === OrganizationMembershipStatus.REVOKED ? now : undefined,
				},
			});
			if (updated.count !== 1) throw new ApiProblemException('PRECONDITION_FAILED');
			await transaction.ownerSession.updateMany({
				where: {
					organizationId: context.organizationId,
					membershipId: target.id,
					revokedAt: null,
				},
				data: { revokedAt: now, revocationReason: 'membership_change' },
			});
			const action: AuditAction =
				input.status === OrganizationMembershipStatus.ACTIVE
					? 'membership_reactivated'
					: input.status === OrganizationMembershipStatus.SUSPENDED
						? 'membership_suspended'
						: 'membership_revoked';
			await this.audit(transaction, context, action, target.id);
		});
	}
}
