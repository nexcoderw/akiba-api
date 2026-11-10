import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { Reflector } from '@nestjs/core';

import { TENANT_IDENTITY_READ } from '../../../common/security/route-access.decorator.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';

@Injectable()
export class OrganizationTenantGuard implements CanActivate {
	constructor(private readonly tenants: TenantAuthorizationService, private readonly reflector: Reflector) {}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<OwnerRequest>();
		const tenant = await this.tenants.establish(request);
		if (!['GET', 'HEAD'].includes(request.method) ||
			this.reflector.get<boolean>(TENANT_IDENTITY_READ, context.getHandler()) !== true) {
			this.tenants.requirePermissions(tenant, ['organization.mutate']);
		}
		return true;
	}
}
