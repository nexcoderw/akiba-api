/** Every platform capability must be registered here before an endpoint can require it. */
export const PLATFORM_PERMISSION = Object.freeze({
	identitiesManage: 'platform.identities.manage',
	dashboardRead: 'platform.dashboard.read',
	organizationsRead: 'platform.organizations.read',
	organizationsCreate: 'platform.organizations.create',
	organizationsUpdate: 'platform.organizations.update',
	organizationsActivate: 'platform.organizations.activate',
	organizationsSuspend: 'platform.organizations.suspend',
	organizationsArchive: 'platform.organizations.archive',
	organizationOwnersInvite: 'platform.organizations.owners.invite',
	organizationOwnersRead: 'platform.organizations.owners.read',
	organizationOwnersRevokeInvitation: 'platform.organizations.owners.revoke-invitation',
	organizationOwnersSendInvitation: 'platform.organizations.owners.send-invitation',
});

/** Trusted system-role key, never an email address, display name or request header. */
export const PLATFORM_SUPERADMIN_ROLE_KEY = 'platform.owner';
