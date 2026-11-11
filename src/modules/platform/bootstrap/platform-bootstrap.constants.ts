import {
	PLATFORM_PERMISSION,
	PLATFORM_SUPERADMIN_ROLE_KEY,
} from '../auth/platform-permission.constants.js';

export const PLATFORM_OWNER_ROLE = Object.freeze({
	key: PLATFORM_SUPERADMIN_ROLE_KEY,
	name: 'Platform owner',
	description: 'Initial Akiba platform owner with explicitly reviewed permissions.',
});

// Preserve the bootstrap's persisted enrollment allowlist for existing pending owners.
// Active system owners receive the full catalog through the live session permission policy.
export const PLATFORM_OWNER_PERMISSIONS = Object.freeze([
	Object.freeze({
		key: PLATFORM_PERMISSION.dashboardRead,
		description: 'View the Akiba platform administration dashboard.',
	}),
]);

export const PLATFORM_OWNER_BOOTSTRAP_LOCK_ID = 5_644_759_676_398_721_837n;
