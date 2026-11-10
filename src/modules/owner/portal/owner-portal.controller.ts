import {
	Controller,
	Get,
	Header,
	Param,
	ParseUUIDPipe,
	Req,
	UseGuards,
} from '@nestjs/common';
import {
	ApiCookieAuth,
	ApiForbiddenResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AccessBoundary, TenantIdentityRead } from '../../../common/security/route-access.decorator.js';
import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import { OwnerOriginCsrfGuard } from '../auth/owner-origin-csrf.guard.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { OrganizationTenantGuard } from '../tenant/organization-tenant.guard.js';
import { TenantAuthorizationService } from '../tenant/tenant-authorization.service.js';
import { TenantPortalService } from '../tenant/tenant-portal.service.js';
import { OwnerDashboardResponseDto } from './dto/owner-dashboard-response.dto.js';

@ApiTags('Organization Portal')
@AccessBoundary('organization')
@Controller('owner/organizations')
@UseGuards(OwnerOriginCsrfGuard, OrganizationTenantGuard)
@ApiCookieAuth('owner-session')
export class OwnerPortalController {
	constructor(private readonly access: TenantAuthorizationService, private readonly portal: TenantPortalService) {}
	@TenantIdentityRead()
	@Get(':organizationId/dashboard')
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Read authorized organization portal identity',
		description:
			'Requires an origin-bound owner session, trusted host, ACTIVE organization and current system owner membership. Scope is rechecked inside the tenant transaction; pending and unavailable organizations share a safe denial.',
	})
	@ApiOkResponse({ type: OwnerDashboardResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiNotFoundResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	dashboard(
		@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
		@Req() request: OwnerRequest,
	): Promise<OwnerDashboardResponseDto> {
		return this.portal.identity(this.access.fromRequest(request), organizationId);
	}
}
