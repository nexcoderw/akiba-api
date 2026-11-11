import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { OWNER_AUTH_ERROR } from '../auth/owner-auth.constants.js';
import { OwnerCookieService } from '../auth/owner-cookie.service.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { OwnerSessionService } from '../auth/owner-session.service.js';
import { OwnerTokenService } from '../auth/owner-token.service.js';

/**
 * Authenticates the invitation recipient before their first organization membership exists.
 * Tenant authorization remains the responsibility of OwnerAcceptanceService for this one transition.
 */
@Injectable()
export class OwnerEnrollmentSessionGuard implements CanActivate {
	constructor(
		private readonly cookies: OwnerCookieService,
		private readonly sessions: OwnerSessionService,
		private readonly tokens: OwnerTokenService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<OwnerRequest>();
		const token = this.cookies.readSession(request);
		if (token === undefined || !this.tokens.isValid(token)) {
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		}
		const principal = await this.sessions.authenticate(token);
		if (principal.enrollmentChallengeId === undefined)
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		request.ownerPrincipal = principal;
		return true;
	}
}
