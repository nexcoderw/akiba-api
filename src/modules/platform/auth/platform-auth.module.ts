import { Module } from '@nestjs/common';
import { ResendEmailService } from '../../../infrastructure/email/resend-email.service.js';
import { PlatformEmailOtpService } from './platform-email-otp.service.js';

import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformCookieService } from './platform-cookie.service.js';
import { PlatformLoginAttemptService } from './platform-login-attempt.service.js';
import { PlatformLoginService } from './platform-login.service.js';
import { PlatformMfaService } from './platform-mfa.service.js';
import { PlatformOriginCsrfGuard } from './platform-origin-csrf.guard.js';
import { PlatformPasswordService } from './platform-password.service.js';
import { PlatformPermissionGuard } from './platform-permission.guard.js';
import { PlatformSessionGuard } from './platform-session.guard.js';
import { PlatformSessionService } from './platform-session.service.js';
import { PlatformTokenService } from './platform-token.service.js';
import { PlatformTotpService } from './platform-totp.service.js';
import { PlatformMfaManagementController } from '../mfa/platform-mfa-management.controller.js';
import { PlatformMfaManagementGuard } from '../mfa/platform-mfa-management.guard.js';
import { PlatformMfaManagementService } from '../mfa/platform-mfa-management.service.js';

@Module({
	controllers: [PlatformAuthController, PlatformMfaManagementController],
	providers: [
		ResendEmailService,
		PlatformEmailOtpService,
		PlatformCookieService,
		PlatformLoginAttemptService,
		PlatformLoginService,
		PlatformMfaService,
		PlatformOriginCsrfGuard,
		PlatformPasswordService,
		PlatformPermissionGuard,
		PlatformSessionGuard,
		PlatformSessionService,
		PlatformTokenService,
		PlatformTotpService,
		PlatformMfaManagementGuard,
		PlatformMfaManagementService,
	],
	// Nest instantiates controller guards in the consuming feature's module context.
	exports: [
		PlatformTotpService,
		ResendEmailService,
		PlatformCookieService,
		PlatformPermissionGuard,
		PlatformSessionGuard,
		PlatformSessionService,
		PlatformOriginCsrfGuard,
		PlatformPasswordService,
		PlatformTokenService,
	],
})
export class PlatformAuthModule {}
