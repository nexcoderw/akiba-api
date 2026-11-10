import { ConflictException } from '@nestjs/common';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

export type OrganizationLifecycleAction = 'activation' | 'suspension' | 'archival';

export const ORGANIZATION_LIFECYCLE_TIMESTAMP = {
	activation: 'activatedAt',
	suspension: 'suspendedAt',
	archival: 'archivedAt',
} as const;

export function lifecycleStatus(
	current: OrganizationStatus,
	action: OrganizationLifecycleAction,
): OrganizationStatus {
	if (action === 'archival' && current !== OrganizationStatus.ARCHIVED) {
		return OrganizationStatus.ARCHIVED;
	}
	if (
		action === 'activation' &&
		(current === OrganizationStatus.PENDING || current === OrganizationStatus.SUSPENDED)
	) {
		return OrganizationStatus.ACTIVE;
	}
	if (action === 'suspension' && current === OrganizationStatus.ACTIVE) {
		return OrganizationStatus.SUSPENDED;
	}
	throw new ConflictException({
		code: 'ORGANIZATION_TRANSITION_CONFLICT',
		message: 'The organization does not permit this lifecycle transition',
	});
}
