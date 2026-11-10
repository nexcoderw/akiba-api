import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { OrganizationAuditAction, type OrganizationStatus, type Prisma } from '@nexcoderw/akiba-db';

export interface OrganizationMutationContext {
	readonly actorPlatformStaffId: string;
	readonly requestId: string;
}

export interface OrganizationAuditEvent extends OrganizationMutationContext {
	readonly action: 'create' | 'update' | 'activation' | 'suspension' | 'archival';
	readonly organizationId: string;
	readonly occurredAt: Date;
	readonly previousStatus: OrganizationStatus | null;
	readonly resultingStatus: OrganizationStatus;
	readonly changedFields: readonly string[];
	readonly previousName: string | null;
	readonly resultingName: string | null;
}

/** Events must be appended using the supplied mutation transaction, never a separate client. */
export abstract class PlatformOrganizationAudit {
	abstract assertAvailable(): void;
	abstract record(
		transaction: Prisma.TransactionClient,
		event: OrganizationAuditEvent,
	): Promise<void>;
}

const AUDIT_ACTION = {
	create: OrganizationAuditAction.CREATE,
	update: OrganizationAuditAction.UPDATE,
	activation: OrganizationAuditAction.ACTIVATE,
	suspension: OrganizationAuditAction.SUSPEND,
	archival: OrganizationAuditAction.ARCHIVE,
} as const;

@Injectable()
export class DurableOrganizationAudit extends PlatformOrganizationAudit {
	override assertAvailable(): void {
		// Actual availability is established by the insert inside the mutation transaction.
	}

	override async record(
		transaction: Prisma.TransactionClient,
		event: OrganizationAuditEvent,
	): Promise<void> {
		try {
			await transaction.organizationAuditEvent.create({
				data: {
					organizationId: event.organizationId,
					actorPlatformStaffId: event.actorPlatformStaffId,
					requestId: event.requestId,
					action: AUDIT_ACTION[event.action],
					occurredAt: event.occurredAt,
					previousStatus: event.previousStatus,
					resultingStatus: event.resultingStatus,
					changedFields: [...event.changedFields],
					previousName: event.previousName,
					resultingName: event.resultingName,
				},
				select: { id: true },
			});
		} catch (error: unknown) {
			throw auditUnavailable(error);
		}
	}
}

@Injectable()
export class UnavailableOrganizationAudit extends PlatformOrganizationAudit {
	override assertAvailable(): void {
		throw auditUnavailable();
	}

	override record(): Promise<void> {
		return Promise.reject(auditUnavailable());
	}
}

function auditUnavailable(cause?: unknown): ServiceUnavailableException {
	return new ServiceUnavailableException(
		{
			code: 'ORGANIZATION_AUDIT_UNAVAILABLE',
			message: 'Durable organization auditing is not available',
		},
		{ cause },
	);
}
