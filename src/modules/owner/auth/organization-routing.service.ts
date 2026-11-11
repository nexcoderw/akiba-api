import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import {
	localRequestAuthority,
	requestAuthority,
} from '../../../common/security/request-authority.js';
import {
	isOrganizationPortalOrigin,
	organizationSlugFromPortalOrigin,
} from '../../../config/organization-portal-origin.js';

export { normalizedAuthority } from '../../../common/security/request-authority.js';

@Injectable()
export class OrganizationRoutingService {
	constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

	/** Shared API hosts use an approved portal Origin as a hint, then live membership authorizes it.
	 * Direct tenant hosts must agree with that Origin. Verified custom domains require a future registry.
	 */
	portal(request: Request): Readonly<{ origin: string; slug: string | null }> {
		const origin = request.headers.origin;
		const policy = {
			fixedOrigin: this.config.get('ORGANIZATION_PORTAL_ORIGIN', { infer: true }),
			baseDomain: this.config.get('ORGANIZATION_PORTAL_BASE_DOMAIN', { infer: true }),
		};
		if (
			typeof origin !== 'string' ||
			!this.config.get('CORS_ORIGINS', { infer: true }).includes(origin) ||
			!isOrganizationPortalOrigin(origin, policy)
		)
			throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
		const authority = requestAuthority(request);
		const api = new URL(this.config.get('API_PUBLIC_ORIGIN', { infer: true }));
		const portal = new URL(origin);
		const localAuthority =
			this.config.get('NODE_ENV', { infer: true }) !== 'production' &&
			authority !== null &&
			localRequestAuthority(request, authority, api);
		if (
			authority === null ||
			(!localAuthority && authority !== api.host && authority !== portal.host)
		) {
			throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
		}
		return Object.freeze({ origin, slug: organizationSlugFromPortalOrigin(origin, policy) });
	}
}
