import { Module } from '@nestjs/common';

import { PlatformAuthModule } from '../platform/auth/platform-auth.module.js';
import { PasswordCredentialService } from './password-credential.service.js';
import { UserIdentityService } from './user-identity.service.js';

/** Internal services only. Import deliberately; no identity-management HTTP routes are registered. */
@Module({
	imports: [PlatformAuthModule],
	providers: [UserIdentityService, PasswordCredentialService],
	exports: [UserIdentityService, PasswordCredentialService],
})
export class IdentityModule {}
