import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { Reflector } from '@nestjs/core';

import {
	TENANT_IDENTITY_READ,
	TENANT_PERMISSION,
} from '../../../common/security/route-access.decorator.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import { OrganizationAuthorizationService } from './organization-authorization.service.js';

@Injectable()
export class OrganizationTenantGuard implements CanActivate {
	constructor(
		private readonly tenants: TenantAuthorizationService,
		private readonly authorization: OrganizationAuthorizationService,
		private readonly reflector: Reflector,
	) {}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<OwnerRequest>();
		const tenant = await this.tenants.establish(request);
		const identityRead =
			this.reflector.get<boolean | undefined>(TENANT_IDENTITY_READ, context.getHandler()) === true;
		const permission = this.reflector.get<string | undefined>(
			TENANT_PERMISSION,
			context.getHandler(),
		);
		if (identityRead && permission !== undefined) this.tenants.requirePermissions(tenant);
		if (['GET', 'HEAD'].includes(request.method) && identityRead) return true;
		if (permission === undefined) this.tenants.requirePermissions(tenant);
		await this.authorization.requireOrganizationPermission(tenant, permission, {
			kind: 'organization',
		});
		return true;
	}
}
