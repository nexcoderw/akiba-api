/** Issued only by TenantAuthorizationService after origin-bound session authentication.
 * Dates are immutable epoch values; no client permissions or ambient mutable singleton identity.
 */
export interface TenantSecurityContext {
	readonly principal: 'organization';
	readonly userId: string;
	readonly organizationId: string;
	readonly organizationSlug: string;
	readonly membershipId: string;
	readonly sessionId: string;
	readonly assurance: 'AAL1' | 'AAL2';
	readonly expiresAt: number;
	readonly requestId: string;
	readonly resourceScope: Readonly<{ organizationId: string; branchIds: readonly string[] }>;
}
