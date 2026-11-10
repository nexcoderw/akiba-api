/** Version-controlled organization capabilities. The matching rows are seeded by akiba-db. */
export const ORGANIZATION_PERMISSION = Object.freeze({
	dashboardRead: 'organization.dashboard.read',
	membersRead: 'organization.members.read',
	membersManage: 'organization.members.manage',
	rolesRead: 'organization.roles.read',
	rolesCreate: 'organization.roles.create',
	rolesUpdate: 'organization.roles.update',
	rolesAssign: 'organization.roles.assign',
	rolesSystem: 'organization.roles.system',
} as const);

export type OrganizationPermission =
	(typeof ORGANIZATION_PERMISSION)[keyof typeof ORGANIZATION_PERMISSION];
export const ORGANIZATION_OWNER_ROLE_KEY = 'owner';
export const OWNER_ONLY_ORGANIZATION_PERMISSIONS: ReadonlySet<OrganizationPermission> = new Set([
	ORGANIZATION_PERMISSION.rolesSystem,
]);

export function isOrganizationPermission(value: unknown): value is OrganizationPermission {
	return (
		typeof value === 'string' && Object.values(ORGANIZATION_PERMISSION).some((key) => key === value)
	);
}

/** Custom roles cannot carry owner-only capabilities, even if a mapping is inserted out of band. */
export function effectiveOrganizationPermissions(
	roles: readonly {
		readonly organizationRole: {
			readonly key: string;
			readonly isSystem: boolean;
			readonly isActive: boolean;
			readonly permissions: readonly {
				readonly organizationPermission: { readonly key: string };
			}[];
		};
	}[],
): ReadonlySet<OrganizationPermission> {
	const effective = new Set<OrganizationPermission>();
	for (const { organizationRole: role } of roles) {
		if (!role.isActive) continue;
		if (role.key === ORGANIZATION_OWNER_ROLE_KEY && role.isSystem) {
			for (const permission of Object.values(ORGANIZATION_PERMISSION)) effective.add(permission);
			continue;
		}
		if (role.isSystem) continue;
		for (const mapping of role.permissions) {
			const key = mapping.organizationPermission.key;
			if (isOrganizationPermission(key) && !OWNER_ONLY_ORGANIZATION_PERMISSIONS.has(key)) {
				effective.add(key);
			}
		}
	}
	return effective;
}
