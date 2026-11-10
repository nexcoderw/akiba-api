import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OrganizationRoutingService } from './organization-routing.service.js';
import { OWNER_CSRF_HEADER, OWNER_CSRF_REQUIRED_METADATA } from './owner-auth.constants.js';
import { OwnerCookieService } from './owner-cookie.service.js';
import type { OwnerRequest } from './owner-request.js';
import { OwnerTokenService } from './owner-token.service.js';

@Injectable()
export class OwnerOriginCsrfGuard implements CanActivate {
	constructor(
		private readonly routing: OrganizationRoutingService,
		private readonly reflector: Reflector,
		private readonly cookies: OwnerCookieService,
		private readonly tokens: OwnerTokenService,
	) {}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<OwnerRequest>();
		const route = this.routing.portal(request);
		if (route.slug !== null) request.ownerOrganizationSlug = route.slug;

		const required = this.reflector.getAllAndOverride<boolean>(OWNER_CSRF_REQUIRED_METADATA, [
			context.getHandler(),
			context.getClass(),
		]);
		if (!required) return true;

		const cookieToken = this.cookies.readCsrf(request);
		const header = request.headers[OWNER_CSRF_HEADER];
		const headerToken = Array.isArray(header) ? undefined : header;
		if (
			cookieToken === undefined ||
			headerToken === undefined ||
			!this.tokens.equal(cookieToken, headerToken)
		) {
			throw new ForbiddenException({
				code: 'OWNER_CSRF_REJECTED',
				message: 'The CSRF token is missing or invalid',
			});
		}
		return true;
	}
}
