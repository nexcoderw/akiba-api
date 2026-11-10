import { randomUUID } from 'node:crypto';

import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import {
	OrganizationOwnerInvitationDeliveryStatus as DeliveryStatus,
	OrganizationOwnerInvitationStatus as InvitationStatus,
	PrismaService,
} from '@nexcoderw/akiba-db';

import { organizationPortalOriginForSlug } from '../../../config/organization-portal-origin.js';
import type {
	OwnerInvitationDeliveryResponseDto,
	OwnerInvitationPreviewResponseDto,
} from './dto/owner-invitation-delivery.dto.js';
import {
	INVITATION_DELIVERY_TRANSACTION,
	invitationDeliveryFailure,
	lockInvitationParents,
	OwnerInvitationDeliveryGate,
} from './owner-invitation-delivery.policy.js';
import { OwnerInvitationTokenEnvelopeService } from './owner-invitation-token-envelope.service.js';
import { OwnerInvitationTokenService } from './owner-invitation-token.service.js';
import {
	PlatformOwnerInvitationAudit,
	type OwnerInvitationMutationContext,
} from './platform-owner-invitation-audit.js';
import {
	assertOrganizationCanReceiveOwnerInvitation,
	ownerInvitationNotFound,
	ownerInvitationOrganizationNotFound,
} from './platform-owner-invitation-policy.js';

import { PlatformSessionService } from '../auth/platform-session.service.js';
import type { PlatformPrincipal } from '../auth/platform-auth.types.js';
import { PLATFORM_PERMISSION } from '../auth/platform-permission.constants.js';

@Injectable()
export class OwnerInvitationDeliveryService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly sessions: PlatformSessionService,
		private readonly gate: OwnerInvitationDeliveryGate,
		private readonly tokens: OwnerInvitationTokenService,
		private readonly envelopes: OwnerInvitationTokenEnvelopeService,
		private readonly audit: PlatformOwnerInvitationAudit,
	) {}

	async queue(
		context: OwnerInvitationMutationContext,
		principal: PlatformPrincipal | undefined,
		organizationId: string,
		invitationId: string,
	): Promise<OwnerInvitationDeliveryResponseDto> {
		context = Object.freeze({ ...context });
		await this.sessions.authorize(principal, PLATFORM_PERMISSION.organizationOwnersSendInvitation, context.actorPlatformStaffId);
		const settings = this.gate.settings();
		await this.gate.assertDatabase();
		this.audit.assertAvailable();
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const now = await lockInvitationParents(transaction, organizationId, invitationId);
				const organization = await transaction.organization.findUnique({
					where: { id: organizationId },
					select: { name: true, slug: true, status: true },
				});
				if (organization === null) throw ownerInvitationOrganizationNotFound();
				assertOrganizationCanReceiveOwnerInvitation(organization.status);
				const invitation = await transaction.organizationOwnerInvitation.findFirst({
					where: { organizationId, id: invitationId },
					select: { status: true, invitedEmail: true },
				});
				if (invitation === null) throw ownerInvitationNotFound();
				if (
					invitation.status === InvitationStatus.REVOKED ||
					invitation.status === InvitationStatus.ACCEPTED
				) {
					throw deliveryConflict();
				}
				const existing = await transaction.organizationOwnerInvitationDelivery.findFirst({
					where: { organizationId, ownerInvitationId: invitationId },
					select: { status: true },
				});
				if (existing !== null) return deliveryResponse(existing.status);
				if (invitation.status !== InvitationStatus.PENDING_DELIVERY) throw deliveryConflict();
				const identity = { id: randomUUID(), organizationId, ownerInvitationId: invitationId };
				const token = this.tokens.generate();
				await transaction.organizationOwnerInvitationDelivery.create({
					data: {
						...identity,
						requestedByPlatformStaffId: context.actorPlatformStaffId,
						status: DeliveryStatus.QUEUED,
						attemptCount: 0,
						maxAttempts: settings.maxAttempts,
						nextAttemptAt: now,
						createdAt: now,
						updatedAt: now,
						providerIdempotencyKey: `owner-invitation-delivery:${identity.id}`,
						tokenDigest: this.tokens.digest(token),
						tokenExpiresAt: new Date(now.getTime() + settings.expirySeconds * 1000),
						...this.envelopes.encrypt(identity, {
							token,
							recipient: invitation.invitedEmail,
							organizationName: organization.name,
							sender: this.gate.sender(),
							acceptanceOrigin: organizationPortalOriginForSlug(
								organization.slug,
								settings.portalOriginPolicy,
							),
							acceptancePath: settings.acceptancePath,
						}),
					},
					select: { id: true },
				});
				await this.audit.record(transaction, {
					...context,
					action: 'queued',
					organizationId,
					invitationId,
					occurredAt: now,
					previousStatus: InvitationStatus.PENDING_DELIVERY,
					resultingStatus: InvitationStatus.PENDING_DELIVERY,
				});
				return deliveryResponse(DeliveryStatus.QUEUED);
			}, INVITATION_DELIVERY_TRANSACTION);
		} catch (error: unknown) {
			throw invitationDeliveryFailure(error);
		}
	}

	async preview(token: string): Promise<OwnerInvitationPreviewResponseDto> {
		this.gate.settings();
		if (!this.tokens.isValidFormat(token)) throw invalidToken();
		await this.gate.assertDatabase();
		try {
			// Database time prevents a slow query or clock skew from extending the validity window.
			const rows = await this.prisma.$queryRaw<{ organizationName: string }[]>`
				SELECT organization.name AS "organizationName"
				FROM public.organization_owner_invitations AS invitation
				JOIN public.organizations AS organization ON organization.id = invitation.organization_id
				WHERE invitation.token_digest = ${this.tokens.digest(token)}
				AND invitation.status = 'sent' AND invitation.expires_at > clock_timestamp()
				AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL
				AND organization.status IN ('pending', 'active') LIMIT 1
			`;
			const name = rows[0]?.organizationName;
			if (name === undefined) throw invalidToken();
			return { valid: true, organizationName: name };
		} catch (error: unknown) {
			throw invitationDeliveryFailure(error);
		}
	}
}

export function deliveryResponse(status: string): OwnerInvitationDeliveryResponseDto {
	const messages: Record<DeliveryStatus, string> = {
		QUEUED: 'Invitation delivery has been queued.',
		PROCESSING: 'Invitation delivery is being processed.',
		CONFIRMED: 'The email provider accepted this invitation. Inbox receipt is not confirmed.',
		FAILED: 'This reservation recorded a delivery failure. Review its status before taking action.',
		UNCERTAIN: 'Delivery could not be confirmed. Operator review is required; do not resend.',
	};
	const known = Object.values(DeliveryStatus).find((value) => value === status);
	if (known === undefined) throw deliveryConflict();
	return { status: known, message: messages[known] };
}

function deliveryConflict(): ConflictException {
	return new ConflictException({
		code: 'OWNER_INVITATION_DELIVERY_CONFLICT',
		message: 'This invitation cannot be queued in its current state.',
	});
}

function invalidToken(): UnauthorizedException {
	return new UnauthorizedException({
		code: 'OWNER_INVITATION_INVALID',
		message: 'This invitation is invalid or unavailable.',
	});
}
