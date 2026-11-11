import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { OWNER_AUTH_ERROR } from './owner-auth.constants.js';
import { OwnerCookieService } from './owner-cookie.service.js';
import type { OwnerRequest } from './owner-request.js';
import { OwnerSessionService } from './owner-session.service.js';
import { OwnerTokenService } from './owner-token.service.js';

@Injectable()
export class OwnerSessionGuard implements CanActivate {
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
		if (principal.enrollmentChallengeId !== undefined)
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		const organizationSlug = request.ownerOrganizationSlug;
		if (organizationSlug === undefined) {
			request.ownerPrincipal = principal;
			return true;
		}
		const organization = principal.organizations.find(({ slug }) => slug === organizationSlug);
		if (organization === undefined) {
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		}
		request.ownerPrincipal = { ...principal, organizations: [organization] };
		return true;
	}
}
