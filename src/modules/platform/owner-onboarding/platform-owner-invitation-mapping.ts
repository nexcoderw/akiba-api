import type { OrganizationOwnerInvitation, Prisma } from '@nexcoderw/akiba-db';

import type { OwnerInvitationResponseDto } from './dto/owner-invitation-response.dto.js';

export const OWNER_INVITATION_SELECT = Object.freeze({
	id: true,
	organizationId: true,
	invitedDisplayName: true,
	invitedEmail: true,
	status: true,
	createdAt: true,
	updatedAt: true,
	sentAt: true,
	expiresAt: true,
	acceptedAt: true,
	revokedAt: true,
	delivery: { select: { status: true } },
} satisfies Prisma.OrganizationOwnerInvitationSelect);

type SafeOwnerInvitation = Pick<
	OrganizationOwnerInvitation,
	| 'id'
	| 'organizationId'
	| 'invitedDisplayName'
	| 'invitedEmail'
	| 'status'
	| 'createdAt'
	| 'updatedAt'
	| 'sentAt'
	| 'expiresAt'
	| 'acceptedAt'
	| 'revokedAt'
> & { readonly delivery: { readonly status: OwnerInvitationResponseDto['deliveryStatus'] } | null };

/** Explicit allowlist prevents token digests, actors and future persistence fields reaching HTTP. */
export function ownerInvitationResponse(row: SafeOwnerInvitation): OwnerInvitationResponseDto {
	return {
		id: row.id,
		organizationId: row.organizationId,
		displayName: row.invitedDisplayName,
		email: row.invitedEmail,
		status: row.status,
		deliveryStatus: row.delivery?.status ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		sentAt: row.sentAt?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		acceptedAt: row.acceptedAt?.toISOString() ?? null,
		revokedAt: row.revokedAt?.toISOString() ?? null,
	};
}
