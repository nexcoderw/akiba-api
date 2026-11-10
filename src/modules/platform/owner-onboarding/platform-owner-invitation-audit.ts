import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
	OrganizationOwnershipAuditAction,
	type OrganizationOwnerInvitationStatus,
	type Prisma,
} from '@nexcoderw/akiba-db';

export interface OwnerInvitationMutationContext {
	readonly actorPlatformStaffId: string;
	readonly requestId: string;
}

export interface OwnerInvitationAuditEvent extends OwnerInvitationMutationContext {
	readonly action: 'created' | 'revoked' | 'queued';
	readonly organizationId: string;
	readonly invitationId: string;
	readonly occurredAt: Date;
	readonly previousStatus: OrganizationOwnerInvitationStatus | null;
	readonly resultingStatus: OrganizationOwnerInvitationStatus;
}

export abstract class PlatformOwnerInvitationAudit {
	abstract assertAvailable(): void;
	abstract record(
		transaction: Prisma.TransactionClient,
		event: OwnerInvitationAuditEvent,
	): Promise<void>;
}

@Injectable()
export class DurableOwnerInvitationAudit extends PlatformOwnerInvitationAudit {
	override assertAvailable(): void {
		// Availability is proven by the audit insert inside the mutation transaction.
	}

	override async record(
		transaction: Prisma.TransactionClient,
		event: OwnerInvitationAuditEvent,
	): Promise<void> {
		try {
			await transaction.organizationOwnershipAuditEvent.create({
				data: {
					organizationId: event.organizationId,
					ownerInvitationId: event.invitationId,
					actorPlatformStaffId: event.actorPlatformStaffId,
					requestId: event.requestId,
					action: {
						created: OrganizationOwnershipAuditAction.INVITATION_CREATED,
						revoked: OrganizationOwnershipAuditAction.INVITATION_REVOKED,
						queued: OrganizationOwnershipAuditAction.INVITATION_DELIVERY_QUEUED,
					}[event.action],
					previousInvitationStatus: event.previousStatus,
					resultingInvitationStatus: event.resultingStatus,
					occurredAt: event.occurredAt,
				},
				select: { id: true },
			});
		} catch (error: unknown) {
			throw ownerInvitationAuditUnavailable(error);
		}
	}
}

@Injectable()
export class UnavailableOwnerInvitationAudit extends PlatformOwnerInvitationAudit {
	override assertAvailable(): void {
		throw ownerInvitationAuditUnavailable();
	}

	override record(): Promise<void> {
		return Promise.reject(ownerInvitationAuditUnavailable());
	}
}

function ownerInvitationAuditUnavailable(cause?: unknown): ServiceUnavailableException {
	return new ServiceUnavailableException(
		{
			code: 'OWNER_INVITATION_AUDIT_UNAVAILABLE',
			message: 'Durable owner invitation auditing is not available',
		},
		{ cause },
	);
}
