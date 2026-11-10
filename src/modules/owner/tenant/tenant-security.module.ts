import { Module } from '@nestjs/common';

import { OwnerAuthModule } from '../auth/owner-auth.module.js';
import { OrganizationTenantGuard } from './organization-tenant.guard.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import { TenantPortalService } from './tenant-portal.service.js';

@Module({
	imports: [OwnerAuthModule],
	providers: [OrganizationTenantGuard, TenantAuthorizationService, TenantPortalService],
	exports: [OrganizationTenantGuard, TenantAuthorizationService, TenantPortalService],
})
export class TenantSecurityModule {}
