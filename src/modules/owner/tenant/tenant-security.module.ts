import { Module } from '@nestjs/common';

import { OwnerAuthModule } from '../auth/owner-auth.module.js';
import { OrganizationAccessManagementService } from './organization-access-management.service.js';
import { OrganizationAuthorizationService } from './organization-authorization.service.js';
import { OrganizationTenantGuard } from './organization-tenant.guard.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import { TenantPortalService } from './tenant-portal.service.js';

@Module({
	imports: [OwnerAuthModule],
	providers: [
		OrganizationAccessManagementService,
		OrganizationAuthorizationService,
		OrganizationTenantGuard,
		TenantAuthorizationService,
		TenantPortalService,
	],
	exports: [
		OrganizationAccessManagementService,
		OrganizationAuthorizationService,
		OrganizationTenantGuard,
		TenantAuthorizationService,
		TenantPortalService,
	],
})
export class TenantSecurityModule {}
