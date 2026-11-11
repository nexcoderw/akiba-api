import {
	PLATFORM_PERMISSION,
	PLATFORM_SUPERADMIN_ROLE_KEY,
} from './platform-permission.constants.js';

interface RoleIdentity {
	readonly platformRole: { readonly key: string; readonly isSystem: boolean };
}

interface RoleWithPermissions extends RoleIdentity {
	readonly platformRole: {
		readonly key: string;
		readonly isSystem: boolean;
		readonly permissions: readonly { readonly platformPermission: { readonly key: string } }[];
	};
}

/** Call only with role assignments loaded from the database for an eligible platform staff member. */
export function isPlatformSuperadmin(roles: readonly RoleIdentity[]): boolean {
	return roles.some(
		({ platformRole }) =>
			platformRole.key === PLATFORM_SUPERADMIN_ROLE_KEY && platformRole.isSystem,
	);
}

/** Owner-role membership grants the complete declared platform catalog, not a wildcard guard bypass. */
export function effectivePlatformPermissions(roles: readonly RoleWithPermissions[]): string[] {
	const catalog = new Set<string>(Object.values(PLATFORM_PERMISSION));
	const explicit = roles.flatMap(({ platformRole }) =>
		platformRole.permissions
			.map(({ platformPermission }) => platformPermission.key)
			.filter((key) => catalog.has(key)),
	);
	return [
		...new Set([
			...explicit,
			...(isPlatformSuperadmin(roles) ? Object.values(PLATFORM_PERMISSION) : []),
		]),
	];
}
