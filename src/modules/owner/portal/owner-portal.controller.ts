import {
	Controller,
	Get,
	Header,
	NotFoundException,
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
import { OrganizationStatus } from '@nexcoderw/akiba-db';

import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import { OwnerOriginCsrfGuard } from '../auth/owner-origin-csrf.guard.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { OwnerSessionGuard } from '../auth/owner-session.guard.js';
import { OwnerDashboardResponseDto } from './dto/owner-dashboard-response.dto.js';

@ApiTags('Organization Portal')
@Controller('owner/organizations')
@UseGuards(OwnerOriginCsrfGuard, OwnerSessionGuard)
@ApiCookieAuth('owner-session')
export class OwnerPortalController {
	@Get(':organizationId/dashboard')
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Read authorized organization portal identity',
		description:
			'Requires a live ACTIVE membership and organization-scoped owner role. ACTIVE and PENDING organizations may read identity; PENDING status grants no operational access. A global session alone grants no tenant access.',
	})
	@ApiOkResponse({ type: OwnerDashboardResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiNotFoundResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	dashboard(
		@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
		@Req() request: OwnerRequest,
	): OwnerDashboardResponseDto {
		const access = request.ownerPrincipal?.organizations.find(
			(organization) =>
				organization.organizationId === organizationId && organization.roles.includes('owner'),
		);
		if (access === undefined) {
			throw new NotFoundException({
				code: 'OWNER_ORGANIZATION_NOT_FOUND',
				message: 'Organization access was not found.',
			});
		}
		if (
			access.status !== OrganizationStatus.ACTIVE &&
			access.status !== OrganizationStatus.PENDING
		) {
			throw new NotFoundException({
				code: 'OWNER_ORGANIZATION_UNAVAILABLE',
				message: 'Organization operations are unavailable.',
			});
		}
		return {
			organizationId: access.organizationId,
			organizationName: access.name,
			organizationSlug: access.slug,
			membershipId: access.membershipId,
			organizationStatus: access.status,
			operationalAccess:
				access.status === OrganizationStatus.ACTIVE ? 'available' : 'pending_activation',
			roles: [...access.roles],
		};
	}
}
