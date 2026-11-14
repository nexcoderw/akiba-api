import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import { PlatformCookieService } from '../auth/platform-cookie.service.js';
import type { PlatformRequest } from '../auth/platform-request.js';
import { PlatformSessionService } from '../auth/platform-session.service.js';

/** Restricted recovery cookies reach only this management controller, never normal platform guards. */
@Injectable()
export class PlatformMfaManagementGuard implements CanActivate {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly cookies: PlatformCookieService,
		private readonly sessions: PlatformSessionService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (!this.config.get('PLATFORM_MFA_MANAGEMENT_ENABLED', { infer: true }))
			throw new ApiProblemException('SERVICE_UNAVAILABLE');
		const request = context.switchToHttp().getRequest<PlatformRequest>();
		const token = this.cookies.readSession(request);
		if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token))
			throw new ApiProblemException('UNAUTHENTICATED');
		request.platformPrincipal = await this.sessions.authenticateForMfaManagement(token);
		return true;
	}
}
