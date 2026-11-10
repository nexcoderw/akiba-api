import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrganizationOwnerInvitationStatus, OrganizationStatus } from '@nexcoderw/akiba-db';

export function assertOrganizationCanReceiveOwnerInvitation(status: OrganizationStatus): void {
	if (status === OrganizationStatus.PENDING || status === OrganizationStatus.ACTIVE) return;
	throw new ConflictException({
		code: 'OWNER_INVITATION_ORGANIZATION_UNAVAILABLE',
		message: 'The organization does not accept owner invitations in its current state',
	});
}

export function assertOwnerInvitationCanBeRevoked(
	status: OrganizationOwnerInvitationStatus,
): asserts status is
	| typeof OrganizationOwnerInvitationStatus.PENDING_DELIVERY
	| typeof OrganizationOwnerInvitationStatus.SENT {
	if (
		status === OrganizationOwnerInvitationStatus.PENDING_DELIVERY ||
		status === OrganizationOwnerInvitationStatus.SENT
	) {
		return;
	}
	throw new ConflictException({
		code: 'OWNER_INVITATION_TRANSITION_CONFLICT',
		message: 'The invitation cannot be revoked in its current state',
	});
}

export function ownerInvitationOrganizationNotFound(): NotFoundException {
	return new NotFoundException({
		code: 'ORGANIZATION_NOT_FOUND',
		message: 'Organization not found',
	});
}

export function ownerInvitationNotFound(): NotFoundException {
	return new NotFoundException({
		code: 'OWNER_INVITATION_NOT_FOUND',
		message: 'Owner invitation not found',
	});
}
