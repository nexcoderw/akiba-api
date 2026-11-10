import { SetMetadata } from '@nestjs/common';

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

/** The only implemented tenant read capability. Other reads require future permission mappings. */
export const TENANT_IDENTITY_READ = Symbol('tenantIdentityRead');
export const TenantIdentityRead = (): ReturnType<typeof SetMetadata> =>
	SetMetadata(TENANT_IDENTITY_READ, true);
