import { Module } from '@nestjs/common';

import { PlatformAuthModule } from './auth/platform-auth.module.js';
import { PlatformBootstrapModule } from './bootstrap/platform-bootstrap.module.js';
import { PlatformDashboardModule } from './dashboard/platform-dashboard.module.js';
import { PlatformOrganizationsModule } from './organizations/platform-organizations.module.js';
import { PlatformOwnerOnboardingModule } from './owner-onboarding/platform-owner-onboarding.module.js';

@Module({
	imports: [
		PlatformAuthModule,
		PlatformBootstrapModule,
		PlatformDashboardModule,
		PlatformOrganizationsModule,
		PlatformOwnerOnboardingModule,
	],
})
export class PlatformModule {}
