import { Injectable } from '@nestjs/common';
import {
	OrganizationMembershipStatus,
	OrganizationStatus,
	TenantTransactionService,
	UserStatus,
} from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { OwnerDashboardResponseDto } from '../portal/dto/owner-dashboard-response.dto.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import type { TenantSecurityContext } from './tenant-security-context.js';

/** Narrow tenant persistence boundary. No unrestricted Prisma client or transaction escapes it. */
@Injectable()
export class TenantPortalService {
	constructor(
		private readonly access: TenantAuthorizationService,
		private readonly transactions: TenantTransactionService,
	) {}

	async identity(
		context: TenantSecurityContext,
		organizationId: string,
	): Promise<OwnerDashboardResponseDto> {
		this.access.assert(context);
		if (organizationId !== context.organizationId)
			throw new ApiProblemException('RESOURCE_NOT_FOUND');
		return this.transactions.run(
			Object.freeze({ organizationId: context.organizationId }),
			async (transaction): Promise<OwnerDashboardResponseDto> => {
				const now = new Date();
				const session = await transaction.ownerSession.findFirst({
					where: {
						id: context.sessionId,
						userId: context.userId,
						organizationId: context.organizationId,
						membershipId: context.membershipId,
						enrollmentChallengeId: null,
						revokedAt: null,
						idleExpiresAt: { gt: now },
						absoluteExpiresAt: { gt: now },
						user: { status: UserStatus.ACTIVE, emailVerifiedAt: { not: null } },
					},
					select: {
						authenticatedAt: true,
						user: {
							select: {
								passwordCredential: { select: { passwordChangedAt: true, disabledAt: true } },
							},
						},
					},
				});
				if (session === null) throw new ApiProblemException('UNAUTHENTICATED');
				const credential = session.user.passwordCredential;
				if (
					credential?.disabledAt !== null ||
					credential.passwordChangedAt > session.authenticatedAt
				) {
					throw new ApiProblemException('UNAUTHENTICATED');
				}
				const membership = await transaction.organizationMembership.findFirst({
					where: {
						id: context.membershipId,
						organizationId: context.organizationId,
						userId: context.userId,
						status: OrganizationMembershipStatus.ACTIVE,
						organization: { slug: context.organizationSlug, status: OrganizationStatus.ACTIVE },
					},
					select: {
						id: true,
						organization: { select: { id: true, name: true, slug: true, status: true } },
						roles: {
							where: {
								organizationId: context.organizationId,
								organizationRole: {
									organizationId: context.organizationId,
									key: 'owner',
									isSystem: true,
								},
							},
							select: { organizationRole: { select: { key: true } } },
						},
					},
				});
				if (membership === null || membership.roles.length === 0)
					throw new ApiProblemException('RESOURCE_NOT_FOUND');
				return {
					organizationId: membership.organization.id,
					organizationName: membership.organization.name,
					organizationSlug: membership.organization.slug,
					membershipId: membership.id,
					organizationStatus: membership.organization.status,
					operationalAccess: 'available',
					roles: membership.roles.map(({ organizationRole }) => organizationRole.key),
				};
			},
			{ maxWait: 5000, timeout: 10000 },
		);
	}
}
