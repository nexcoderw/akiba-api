import { SetMetadata } from '@nestjs/common';
import type { OrganizationPermission } from '../../modules/owner/tenant/organization-permission.constants.js';

export const ROUTE_ACCESS = Symbol('routeAccess');
export type RouteAccess =
	| 'public'
	| 'platform'
	| 'platform-session'
	| 'owner-session'
	| 'owner-enrollment'
	| 'organization';

/** Every HTTP handler declares a boundary; this metadata never grants authentication. */
export const AccessBoundary = (access: RouteAccess): ReturnType<typeof SetMetadata> =>
	SetMetadata(ROUTE_ACCESS, access);

/** Existing owner dashboard identity read remains narrowly explicit. */
export const TENANT_IDENTITY_READ = Symbol('tenantIdentityRead');
export const TenantIdentityRead = (): ReturnType<typeof SetMetadata> =>
	SetMetadata(TENANT_IDENTITY_READ, true);

export const TENANT_PERMISSION = Symbol('tenantPermission');
/** Declares a capability for a future tenant handler; the guard still checks live grants. */
export const RequireOrganizationPermission = (
	permission: OrganizationPermission,
): ReturnType<typeof SetMetadata> => SetMetadata(TENANT_PERMISSION, permission);
