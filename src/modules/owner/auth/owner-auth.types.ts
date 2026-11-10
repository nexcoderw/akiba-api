import type { OrganizationStatus } from '@nexcoderw/akiba-db';

export interface OwnerOrganizationAccess {
	readonly organizationId: string;
	readonly name: string;
	readonly slug: string;
	readonly status: OrganizationStatus;
	readonly membershipId: string;
	readonly roles: readonly string[];
}

export interface OwnerPrincipal {
	readonly sessionId: string;
	readonly userId: string;
	readonly displayName: string;
	readonly email: string;
	readonly assurance: 'AAL1' | 'AAL2';
	readonly expiresAt: Date;
	readonly organizations: readonly OwnerOrganizationAccess[];
}
