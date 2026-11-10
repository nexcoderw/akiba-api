import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';

import { OwnerOriginCsrfGuard } from '../../modules/owner/auth/owner-origin-csrf.guard.js';
import { OwnerSessionGuard } from '../../modules/owner/auth/owner-session.guard.js';
import { OwnerEnrollmentSessionGuard } from '../../modules/owner/enrollment/owner-enrollment-session.guard.js';
import { OrganizationTenantGuard } from '../../modules/owner/tenant/organization-tenant.guard.js';
import { PlatformOriginCsrfGuard } from '../../modules/platform/auth/platform-origin-csrf.guard.js';
import { PlatformPermissionGuard } from '../../modules/platform/auth/platform-permission.guard.js';
import { PlatformSessionGuard } from '../../modules/platform/auth/platform-session.guard.js';
import { ApiProblemException } from '../errors/api-problem.exception.js';
import { ROUTE_ACCESS, type RouteAccess } from './route-access.decorator.js';

const REQUIRED: Readonly<Record<Exclude<RouteAccess, 'public'>, readonly object[]>> = {
	platform: [PlatformOriginCsrfGuard, PlatformSessionGuard, PlatformPermissionGuard],
	'platform-session': [PlatformOriginCsrfGuard, PlatformSessionGuard],
	'owner-session': [OwnerOriginCsrfGuard, OwnerSessionGuard],
	'owner-enrollment': [OwnerOriginCsrfGuard, OwnerEnrollmentSessionGuard],
	organization: [OwnerOriginCsrfGuard, OrganizationTenantGuard],
};

/** Default deny. Protected declarations also require the actual guards Nest will execute.
 * This does not authenticate twice or turn a route label into an authorization grant.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
	constructor(private readonly reflector: Reflector) {}
	canActivate(context: ExecutionContext): boolean {
		const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
			context.getHandler(),
			context.getClass(),
		]);
		if (access === 'public') return true;
		if (access === undefined || !Object.hasOwn(REQUIRED, access))
			throw new ApiProblemException('ACCESS_DENIED');
		const guards: unknown[] = [
			...(this.reflector.get<unknown[] | undefined>(GUARDS_METADATA, context.getClass()) ?? []),
			...(this.reflector.get<unknown[] | undefined>(GUARDS_METADATA, context.getHandler()) ?? []),
		];
		if (!REQUIRED[access].every((guard) => guards.includes(guard))) {
			throw new ApiProblemException('ACCESS_DENIED');
		}
		return true;
	}
}
