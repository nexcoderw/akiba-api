import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { isOrganizationPortalOrigin, organizationSlugFromPortalOrigin } from '../../../config/organization-portal-origin.js';

function proxyMatcher(value: unknown): value is (address: string, hop: number) => boolean {
	return typeof value === 'function';
}

/** Accept only one canonical authority; URL parsing alone accepts userinfo and path tricks. */
export function normalizedAuthority(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 260 ||
		! /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[::1\])(?::[0-9]{1,5})?$/iu.test(value)) return null;
	try {
		const url = new URL(`https://${value.toLowerCase()}`);
		if (url.hostname.endsWith('.') || url.hostname.includes('..')) return null;
		return url.host;
	} catch { return null; }
}

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
		if (typeof origin !== 'string' ||
			!this.config.get('CORS_ORIGINS', { infer: true }).includes(origin) ||
			!isOrganizationPortalOrigin(origin, policy)) throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
		let authority = normalizedAuthority(request.headers.host);
		const trust: unknown = request.app.get('trust proxy fn');
		if (request.socket.remoteAddress !== undefined && proxyMatcher(trust) &&
			trust(request.socket.remoteAddress, 0) && request.headers['x-forwarded-host'] !== undefined) {
			authority = normalizedAuthority(request.headers['x-forwarded-host']);
		}
		const api = new URL(this.config.get('API_PUBLIC_ORIGIN', { infer: true }));
		const portal = new URL(origin);
		const local = this.config.get('NODE_ENV', { infer: true }) !== 'production' &&
			['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
		const localAuthority = local && authority !== null &&
			['localhost', '127.0.0.1', '[::1]'].includes(new URL(`https://${authority}`).hostname) &&
			new URL(`https://${authority}`).port === String(request.socket.localPort);
		if (authority === null || (!localAuthority && authority !== api.host && authority !== portal.host)) {
			throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
		}
		return Object.freeze({ origin, slug: organizationSlugFromPortalOrigin(origin, policy) });
	}
}
