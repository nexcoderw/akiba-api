import { Module } from '@nestjs/common';

import { OwnerAuthModule } from '../auth/owner-auth.module.js';
import { TenantSecurityModule } from '../tenant/tenant-security.module.js';
import { OwnerPortalController } from './owner-portal.controller.js';

@Module({
	imports: [OwnerAuthModule, TenantSecurityModule],
	controllers: [OwnerPortalController],
})
export class OwnerPortalModule {}
