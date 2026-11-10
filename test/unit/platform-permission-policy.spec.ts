import { PLATFORM_PERMISSION } from '../../src/modules/platform/auth/platform-permission.constants.js';
import {
	effectivePlatformPermissions,
	isPlatformSuperadmin,
} from '../../src/modules/platform/auth/platform-permission-policy.js';
import { ORGANIZATION_PERMISSION } from '../../src/modules/platform/organizations/platform-organizations.constants.js';
import { OWNER_INVITATION_PERMISSION } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.constants.js';

function role(key: string, isSystem: boolean, permissions: string[] = []) {
	return {
		platformRole: {
			key,
			isSystem,
			permissions: permissions.map((permission) => ({ platformPermission: { key: permission } })),
		},
	};
}

describe('platform superadmin permission policy', () => {
	it('grants the entire declared catalog without per-permission database assignments', () => {
		expect(effectivePlatformPermissions([role('platform.owner', true)])).toEqual(
			Object.values(PLATFORM_PERMISSION),
		);
		for (const permission of Object.values(ORGANIZATION_PERMISSION)) {
			expect(Object.values(PLATFORM_PERMISSION)).toContain(permission);
		}
		for (const permission of Object.values(OWNER_INVITATION_PERMISSION)) {
			expect(Object.values(PLATFORM_PERMISSION)).toContain(permission);
		}
	});
	it.each([
		role('platform.owner', false),
		role('platform.operator', true),
		role('superadmin', true),
		role('organization.owner', true),
	])('does not elevate lookalike or non-system roles: %p', (assignment) => {
		expect(isPlatformSuperadmin([assignment])).toBe(false);
		expect(effectivePlatformPermissions([assignment])).toEqual([]);
	});
	it('preserves and deduplicates ordinary explicit permissions without granting extra access', () => {
		expect(
			effectivePlatformPermissions([
				role('platform.auditor', false, [PLATFORM_PERMISSION.dashboardRead]),
				role('platform.reader', false, [PLATFORM_PERMISSION.dashboardRead]),
			]),
		).toEqual([PLATFORM_PERMISSION.dashboardRead]);
	});
	it('removes automatic permissions when the trusted owner assignment is removed', () => {
		expect(effectivePlatformPermissions([])).toEqual([]);
	});
});
