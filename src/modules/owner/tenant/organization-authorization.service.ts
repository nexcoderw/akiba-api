import { Injectable } from '@nestjs/common';
import {
	OrganizationMembershipStatus,
	OrganizationStatus,
	type Prisma,
	TenantTransactionService,
	UserStatus,
} from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import {
	OWNER_ONLY_ORGANIZATION_PERMISSIONS,
	effectiveOrganizationPermissions,
	isOrganizationPermission,
	type OrganizationPermission,
} from './organization-permission.constants.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import type { TenantSecurityContext } from './tenant-security-context.js';

export type OrganizationResourceScope =
	Readonly<{ kind: 'organization' }> | Readonly<{ kind: 'branch'; branchId: string }>;

/** Rechecks the issued identity and current grants in the same transaction as a protected write. */
@Injectable()
export class OrganizationAuthorizationService {
	constructor(
		private readonly access: TenantAuthorizationService,
		private readonly transactions: TenantTransactionService,
	) {}

	async hasOrganizationPermission(
		context: TenantSecurityContext,
		permission: string,
		scope: OrganizationResourceScope,
	): Promise<boolean> {
		this.access.assert(context);
		return this.transactions.run(
			{ organizationId: context.organizationId },
			async (transaction) => {
				const grants = await this.effectiveInTransaction(transaction, context);
				return this.allowed(context, grants, permission, scope);
			},
		);
	}

	async requireOrganizationPermission(
		context: TenantSecurityContext,
		permission: string,
		scope: OrganizationResourceScope,
	): Promise<void> {
		if (!(await this.hasOrganizationPermission(context, permission, scope))) {
			throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
		}
	}

	private allowed(
		context: TenantSecurityContext,
		grants: ReadonlySet<OrganizationPermission>,
		permission: string,
		scope: unknown,
	): boolean {
		this.access.assert(context);
		if (!isOrganizationPermission(permission)) return false;
		if (typeof scope !== 'object' || scope === null || !('kind' in scope)) return false;
		if (scope.kind === 'organization') return grants.has(permission);
		if (scope.kind !== 'branch' || !('branchId' in scope) || typeof scope.branchId !== 'string') {
			return false;
		}
		return context.resourceScope.branchIds.includes(scope.branchId) && grants.has(permission);
	}

	async effectiveInTransaction(
		transaction: Prisma.TransactionClient,
		context: TenantSecurityContext,
	): Promise<ReadonlySet<OrganizationPermission>> {
		this.access.assert(context);
		const now = new Date();
		const session = await transaction.ownerSession.findFirst({
			where: {
				id: context.sessionId,
				userId: context.userId,
				revokedAt: null,
				idleExpiresAt: { gt: now },
				absoluteExpiresAt: { gt: now },
				user: { status: UserStatus.ACTIVE, emailVerifiedAt: { not: null } },
			},
			select: {
				authenticatedAt: true,
				assurance: true,
				mfaVerifiedAt: true,
				user: {
					select: { passwordCredential: { select: { disabledAt: true, passwordChangedAt: true } } },
				},
			},
		});
		if (session === null) throw new ApiProblemException('UNAUTHENTICATED');
		const credential = session.user.passwordCredential;
		if (credential === null) throw new ApiProblemException('UNAUTHENTICATED');
		if (
			credential.disabledAt !== null ||
			credential.passwordChangedAt > session.authenticatedAt ||
			session.assurance !== context.assurance
		)
			throw new ApiProblemException('UNAUTHENTICATED');
		const membership = await transaction.organizationMembership.findFirst({
			where: {
				id: context.membershipId,
				organizationId: context.organizationId,
				userId: context.userId,
				status: OrganizationMembershipStatus.ACTIVE,
				organization: { slug: context.organizationSlug, status: OrganizationStatus.ACTIVE },
			},
			select: {
				roles: {
					where: {
						organizationId: context.organizationId,
						organizationRole: { organizationId: context.organizationId },
					},
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
		if (membership === null) throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
		const grants = new Set(effectiveOrganizationPermissions(membership.roles));
		if (session.assurance !== 'AAL2' || session.mfaVerifiedAt === null) {
			for (const permission of OWNER_ONLY_ORGANIZATION_PERMISSIONS) grants.delete(permission);
		}
		return grants;
	}
}
