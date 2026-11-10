import { BadRequestException, Injectable } from '@nestjs/common';
import { OrganizationOwnerInvitationStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import type { CreateOwnerInvitationDto } from './dto/create-owner-invitation.dto.js';
import type { ListOwnerInvitationsQueryDto } from './dto/list-owner-invitations-query.dto.js';
import type { OwnerInvitationListResponseDto } from './dto/owner-invitation-list-response.dto.js';
import type { OwnerInvitationResponseDto } from './dto/owner-invitation-response.dto.js';
import {
	PlatformOwnerInvitationAudit,
	type OwnerInvitationMutationContext,
} from './platform-owner-invitation-audit.js';
import {
	ownerInvitationConcurrentChange,
	ownerInvitationFailure,
} from './platform-owner-invitation-errors.js';
import {
	OWNER_INVITATION_SELECT,
	ownerInvitationResponse,
} from './platform-owner-invitation-mapping.js';
import {
	assertOrganizationCanReceiveOwnerInvitation,
	assertOwnerInvitationCanBeRevoked,
	ownerInvitationNotFound,
	ownerInvitationOrganizationNotFound,
} from './platform-owner-invitation-policy.js';
import { OWNER_INVITATION_TRANSACTION_OPTIONS } from './platform-owner-onboarding.constants.js';

@Injectable()
export class PlatformOwnerOnboardingService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly audit: PlatformOwnerInvitationAudit,
	) {}

	async create(
		context: OwnerInvitationMutationContext,
		organizationId: string,
		input: CreateOwnerInvitationDto,
	): Promise<OwnerInvitationResponseDto> {
		this.audit.assertAvailable();
		try {
			return await this.prisma.$transaction(
				async (transaction) => {
					const organization = await transaction.organization.findUnique({
						where: { id: organizationId },
						select: { status: true },
					});
					if (organization === null) throw ownerInvitationOrganizationNotFound();
					assertOrganizationCanReceiveOwnerInvitation(organization.status);

					const occurredAt = new Date();
					const invitation = await transaction.organizationOwnerInvitation.create({
						data: {
							organizationId,
							invitedDisplayName: input.displayName,
							invitedEmail: input.email,
							invitedByPlatformStaffId: context.actorPlatformStaffId,
							status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
							tokenDigest: null,
							expiresAt: null,
							sentAt: null,
							acceptedAt: null,
							revokedAt: null,
						},
						select: OWNER_INVITATION_SELECT,
					});
					await this.audit.record(transaction, {
						...context,
						action: 'created',
						organizationId,
						invitationId: invitation.id,
						occurredAt,
						previousStatus: null,
						resultingStatus: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
					});
					return ownerInvitationResponse(invitation);
				},
				{
					...OWNER_INVITATION_TRANSACTION_OPTIONS,
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				},
			);
		} catch (error: unknown) {
			throw ownerInvitationFailure(error);
		}
	}

	async list(
		organizationId: string,
		query: ListOwnerInvitationsQueryDto,
	): Promise<OwnerInvitationListResponseDto> {
		if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) {
			throw new BadRequestException({
				code: 'OWNER_INVITATION_PAGE_INVALID',
				message: 'Page size must be between 1 and 50',
			});
		}
		try {
			return await this.prisma.$transaction(
				async (transaction) => {
					const organization = await transaction.organization.findUnique({
						where: { id: organizationId },
						select: { id: true },
					});
					if (organization === null) throw ownerInvitationOrganizationNotFound();

					const where: Prisma.OrganizationOwnerInvitationWhereInput = {
						organizationId,
						...(query.status === undefined ? {} : { status: query.status }),
					};
					if (query.cursor !== undefined) {
						const cursor = await transaction.organizationOwnerInvitation.findFirst({
							where: { ...where, id: query.cursor },
							select: { id: true },
						});
						if (cursor === null) {
							throw new BadRequestException({
								code: 'OWNER_INVITATION_CURSOR_INVALID',
								message:
									'The cursor is unavailable for this organization and filter; restart pagination',
							});
						}
					}

					const rows = await transaction.organizationOwnerInvitation.findMany({
						where,
						orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
						take: query.limit + 1,
						...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
						select: OWNER_INVITATION_SELECT,
					});
					const page = rows.slice(0, query.limit);
					return {
						items: page.map(ownerInvitationResponse),
						nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
					};
				},
				{
					...OWNER_INVITATION_TRANSACTION_OPTIONS,
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
				},
			);
		} catch (error: unknown) {
			throw ownerInvitationFailure(error);
		}
	}

	async revoke(
		context: OwnerInvitationMutationContext,
		organizationId: string,
		invitationId: string,
	): Promise<OwnerInvitationResponseDto> {
		this.audit.assertAvailable();
		try {
			return await this.prisma.$transaction(
				async (transaction) => {
					const previous = await transaction.organizationOwnerInvitation.findFirst({
						where: { id: invitationId, organizationId },
						select: OWNER_INVITATION_SELECT,
					});
					if (previous === null) throw ownerInvitationNotFound();
					assertOwnerInvitationCanBeRevoked(previous.status);

					const occurredAt = new Date();
					const updatedAt = new Date(
						Math.max(occurredAt.getTime(), previous.updatedAt.getTime() + 1),
					);
					const result = await transaction.organizationOwnerInvitation.updateMany({
						where: {
							id: invitationId,
							organizationId,
							status: previous.status,
						},
						data: {
							status: OrganizationOwnerInvitationStatus.REVOKED,
							revokedAt: occurredAt,
							tokenDigest: null,
							updatedAt,
						},
					});
					if (result.count !== 1) throw ownerInvitationConcurrentChange();

					const invitation = await transaction.organizationOwnerInvitation.findFirst({
						where: { id: invitationId, organizationId },
						select: OWNER_INVITATION_SELECT,
					});
					if (invitation === null) throw ownerInvitationNotFound();
					await this.audit.record(transaction, {
						...context,
						action: 'revoked',
						organizationId,
						invitationId,
						occurredAt,
						previousStatus: previous.status,
						resultingStatus: OrganizationOwnerInvitationStatus.REVOKED,
					});
					return ownerInvitationResponse(invitation);
				},
				{
					...OWNER_INVITATION_TRANSACTION_OPTIONS,
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				},
			);
		} catch (error: unknown) {
			throw ownerInvitationFailure(error);
		}
	}
}
