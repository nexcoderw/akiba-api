import { Injectable } from '@nestjs/common';
import {
	OrganizationMembershipStatus,
	OrganizationOwnerEnrollmentStatus,
	OrganizationOwnerInvitationStatus,
	OrganizationStatus,
	Prisma,
	PrismaService,
	UserStatus,
} from '@nexcoderw/akiba-db';

import type { OwnerPrincipal } from '../auth/owner-auth.types.js';
import { OwnerTokenService } from '../auth/owner-token.service.js';
import type { OwnerInvitationAcceptedResponseDto } from './dto/owner-enrollment-response.dto.js';
import {
	invalidOwnerEnrollment,
	ownerEnrollmentConflict,
	ownerEnrollmentFailure,
} from './owner-enrollment-errors.js';

const TRANSACTION_OPTIONS = Object.freeze({
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 10_000,
	timeout: 15_000,
});

@Injectable()
export class OwnerAcceptanceService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly tokens: OwnerTokenService,
	) {}

	async accept(
		principal: OwnerPrincipal,
		challengeToken: string,
		requestId: string,
		now = new Date(),
		organizationSlug?: string,
	): Promise<OwnerInvitationAcceptedResponseDto> {
		if (!this.tokens.isValid(challengeToken)) throw invalidOwnerEnrollment();
		const challengeDigest = this.tokens.enrollmentDigest(challengeToken);
		try {
			return await this.prisma.$transaction(async (transaction) => {
				await transaction.$queryRaw`
					SELECT id
					FROM public.organization_owner_enrollment_challenges
					WHERE token_digest = ${challengeDigest}
					FOR UPDATE
				`;
				const challenge = await transaction.organizationOwnerEnrollmentChallenge.findUnique({
					where: { tokenDigest: challengeDigest },
					select: {
						id: true,
						organizationId: true,
						ownerInvitationId: true,
						userId: true,
						status: true,
						expiresAt: true,
						ownerInvitation: {
							select: {
								id: true,
								invitedEmail: true,
								status: true,
								expiresAt: true,
								tokenDigest: true,
								organization: {
									select: { id: true, name: true, slug: true, status: true },
								},
							},
						},
						user: {
							select: { id: true, email: true, status: true, emailVerifiedAt: true },
						},
					},
				});
				if (
					challenge?.status !== OrganizationOwnerEnrollmentStatus.VERIFIED ||
					challenge.id !== principal.enrollmentChallengeId ||
					challenge.expiresAt <= now ||
					challenge.userId !== principal.userId ||
					challenge.user?.status !== UserStatus.ACTIVE ||
					challenge.user.emailVerifiedAt === null ||
					challenge.user.email.toLowerCase() !== principal.email.toLowerCase() ||
					challenge.ownerInvitation.invitedEmail.toLowerCase() !== principal.email.toLowerCase() ||
					challenge.ownerInvitation.status !== OrganizationOwnerInvitationStatus.SENT ||
					challenge.ownerInvitation.expiresAt === null ||
					challenge.ownerInvitation.expiresAt <= now ||
					challenge.ownerInvitation.tokenDigest === null
				) {
					throw invalidOwnerEnrollment();
				}
				const organization = challenge.ownerInvitation.organization;
				if (
					(organizationSlug !== undefined && organization.slug !== organizationSlug) ||
					(organization.status !== OrganizationStatus.PENDING &&
						organization.status !== OrganizationStatus.ACTIVE)
				) {
					throw ownerEnrollmentConflict('This organization is not eligible for owner enrollment.');
				}

				const ownerRole = await transaction.organizationRole.upsert({
					where: {
						organizationId_key: { organizationId: organization.id, key: 'owner' },
					},
					create: {
						organizationId: organization.id,
						key: 'owner',
						name: 'Owner',
						description: 'System role for the verified organization owner.',
						isSystem: true,
					},
					update: {},
					select: { id: true, key: true, name: true, isSystem: true },
				});
				if (!ownerRole.isSystem || ownerRole.key !== 'owner' || ownerRole.name !== 'Owner') {
					throw ownerEnrollmentConflict('The organization owner role is not safely provisioned.');
				}

				const currentMembership = await transaction.organizationMembership.findUnique({
					where: {
						organizationId_userId: {
							organizationId: organization.id,
							userId: principal.userId,
						},
					},
					select: { id: true, status: true },
				});
				if (
					currentMembership?.status === OrganizationMembershipStatus.SUSPENDED ||
					currentMembership?.status === OrganizationMembershipStatus.REVOKED
				) {
					throw ownerEnrollmentConflict(
						'A restricted membership cannot be reactivated by invitation.',
					);
				}
				const membership =
					currentMembership === null
						? await transaction.organizationMembership.create({
								data: {
									organizationId: organization.id,
									userId: principal.userId,
									status: OrganizationMembershipStatus.ACTIVE,
									activatedAt: now,
								},
								select: { id: true },
							})
						: currentMembership.status === OrganizationMembershipStatus.PENDING
							? await transaction.organizationMembership.update({
									where: { id: currentMembership.id },
									data: {
										status: OrganizationMembershipStatus.ACTIVE,
										activatedAt: now,
									},
									select: { id: true },
								})
							: { id: currentMembership.id };

				await transaction.organizationMembershipRole.upsert({
					where: {
						organizationId_organizationMembershipId_organizationRoleId: {
							organizationId: organization.id,
							organizationMembershipId: membership.id,
							organizationRoleId: ownerRole.id,
						},
					},
					create: {
						organizationId: organization.id,
						organizationMembershipId: membership.id,
						organizationRoleId: ownerRole.id,
						assignedAt: now,
					},
					update: {},
				});
				// The proof guard requires a still-sent invitation when consuming the challenge.
				// Both transitions and the audit must commit together in this transaction.
				const challengeUpdate = await transaction.organizationOwnerEnrollmentChallenge.updateMany({
					where: {
						id: challenge.id,
						userId: principal.userId,
						status: OrganizationOwnerEnrollmentStatus.VERIFIED,
						expiresAt: { gt: now },
					},
					data: {
						status: OrganizationOwnerEnrollmentStatus.CONSUMED,
						tokenDigest: null,
						consumedAt: now,
						updatedAt: now,
					},
				});
				if (challengeUpdate.count !== 1) throw invalidOwnerEnrollment();
				const invitationUpdate = await transaction.organizationOwnerInvitation.updateMany({
					where: {
						id: challenge.ownerInvitationId,
						organizationId: organization.id,
						status: OrganizationOwnerInvitationStatus.SENT,
						tokenDigest: { not: null },
						expiresAt: { gt: now },
					},
					data: {
						status: OrganizationOwnerInvitationStatus.ACCEPTED,
						acceptedAt: now,
						tokenDigest: null,
						updatedAt: now,
					},
				});
				if (invitationUpdate.count !== 1) throw invalidOwnerEnrollment();
				await transaction.organizationOwnerAcceptanceAuditEvent.create({
					data: {
						organizationId: organization.id,
						ownerInvitationId: challenge.ownerInvitationId,
						enrollmentChallengeId: challenge.id,
						actorUserId: principal.userId,
						organizationMembershipId: membership.id,
						requestId,
						occurredAt: now,
					},
				});
				return {
					status: 'accepted' as const,
					organizationId: organization.id,
					organizationName: organization.name,
					organizationSlug: organization.slug,
					organizationStatus: organization.status,
					membershipId: membership.id,
				};
			}, TRANSACTION_OPTIONS);
		} catch (error: unknown) {
			throw ownerEnrollmentFailure(error);
		}
	}
}
