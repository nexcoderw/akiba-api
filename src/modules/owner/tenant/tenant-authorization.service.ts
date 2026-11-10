import { Injectable } from '@nestjs/common';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import { ensureRequestId } from '../../../common/logging/request-observation.js';
import { OwnerCookieService } from '../auth/owner-cookie.service.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { OwnerSessionService } from '../auth/owner-session.service.js';
import { OrganizationRoutingService } from '../auth/organization-routing.service.js';
import type { TenantSecurityContext } from './tenant-security-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class TenantAuthorizationService {
	private readonly issued = new WeakSet<TenantSecurityContext>();
	private readonly requests = new WeakMap<OwnerRequest, TenantSecurityContext>();

	constructor(
		private readonly routing: OrganizationRoutingService,
		private readonly cookies: OwnerCookieService,
		private readonly sessions: OwnerSessionService,
	) {}

	async establish(request: OwnerRequest): Promise<TenantSecurityContext> {
		const route = this.routing.portal(request);
		const token = this.cookies.readSession(request);
		if (token === undefined) throw new ApiProblemException('UNAUTHENTICATED');
		const principal = await this.sessions.authenticate(token);
		const access = principal.organizations.find(
			(item) => item.slug === route.slug && item.status === OrganizationStatus.ACTIVE,
		);
		if (access === undefined) throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
		const context: TenantSecurityContext = Object.freeze({
			principal: 'organization',
			userId: principal.userId,
			organizationId: access.organizationId,
			organizationSlug: access.slug,
			membershipId: access.membershipId,
			sessionId: principal.sessionId,
			assurance: principal.assurance,
			expiresAt: principal.expiresAt.getTime(),
			requestId: ensureRequestId(request),
			resourceScope: Object.freeze({
				organizationId: access.organizationId,
				branchIds: Object.freeze([]),
			}),
		});
		this.issued.add(context);
		this.requests.set(request, context);
		return context;
	}

	fromRequest(request: OwnerRequest): TenantSecurityContext {
		const context = this.requests.get(request);
		if (context === undefined) throw new ApiProblemException('UNAUTHENTICATED');
		this.assert(context);
		return context;
	}

	assert(context: TenantSecurityContext): void {
		if (!this.issued.has(context) || context.expiresAt <= Date.now())
			throw new ApiProblemException('ORGANIZATION_UNAVAILABLE');
	}

	/** Scope always comes from the issued context, never a caller's organization filter. */
	resourceWhere(
		context: TenantSecurityContext,
		resourceId: string,
	): Readonly<{ organizationId: string; id: string }> {
		this.assert(context);
		if (!UUID.test(resourceId)) throw new ApiProblemException('RESOURCE_NOT_FOUND');
		return Object.freeze({ organizationId: context.organizationId, id: resourceId });
	}

	resourceWhereMany(
		context: TenantSecurityContext,
		resourceIds: readonly string[],
	): Readonly<{
		organizationId: string;
		id: Readonly<{ in: readonly string[] }>;
	}> {
		this.assert(context);
		if (
			resourceIds.length === 0 ||
			resourceIds.length > 100 ||
			resourceIds.some((id) => !UUID.test(id))
		) {
			throw new ApiProblemException('BAD_REQUEST');
		}
		return Object.freeze({
			organizationId: context.organizationId,
			id: Object.freeze({ in: Object.freeze([...new Set(resourceIds)]) }),
		});
	}

	/** No organization permission/branch catalog exists yet. Owner status grants no blanket access. */
	requirePermissions(context: TenantSecurityContext): never {
		this.assert(context);
		throw new ApiProblemException('ORGANIZATION_ACCESS_DENIED');
	}
}
