import {
	Body,
	BadRequestException,
	Controller,
	Get,
	Header,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UnauthorizedException,
	UseGuards,
} from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiAcceptedResponse,
	ApiConflictResponse,
	ApiCookieAuth,
	ApiCreatedResponse,
	ApiForbiddenResponse,
	ApiHeader,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiParam,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiTooManyRequestsResponse,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AccessBoundary } from '../../../common/security/route-access.decorator.js';
import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import { RequirePlatformCsrf } from '../auth/platform-csrf.decorator.js';
import { PlatformOriginCsrfGuard } from '../auth/platform-origin-csrf.guard.js';
import { PlatformPermissionGuard } from '../auth/platform-permission.guard.js';
import { RequirePlatformPermissions } from '../auth/platform-permissions.decorator.js';
import type { PlatformRequest } from '../auth/platform-request.js';
import { PlatformSessionGuard } from '../auth/platform-session.guard.js';
import { CreateOwnerInvitationDto } from './dto/create-owner-invitation.dto.js';
import { ListOwnerInvitationsQueryDto } from './dto/list-owner-invitations-query.dto.js';
import { OwnerInvitationListResponseDto } from './dto/owner-invitation-list-response.dto.js';
import { OwnerInvitationResponseDto } from './dto/owner-invitation-response.dto.js';
import { OwnerInvitationDeliveryResponseDto } from './dto/owner-invitation-delivery.dto.js';
import { OwnerInvitationDeliveryService } from './owner-invitation-delivery.service.js';
import type { OwnerInvitationMutationContext } from './platform-owner-invitation-audit.js';
import { PlatformOwnerOnboardingService } from './platform-owner-onboarding.service.js';
import { OWNER_INVITATION_PERMISSION } from './platform-owner-onboarding.constants.js';

@ApiTags('Platform owner onboarding')
@ApiCookieAuth('platform-session')
@ApiBadRequestResponse({ type: ApiErrorResponseDto })
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiForbiddenResponse({ type: ApiErrorResponseDto })
@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
@ApiServiceUnavailableResponse({
	type: ApiErrorResponseDto,
	description: 'Invitation persistence or durable ownership auditing is unavailable.',
})
@UseGuards(PlatformSessionGuard, PlatformOriginCsrfGuard, PlatformPermissionGuard)
@AccessBoundary('platform')
@Controller('platform/organizations/:organizationId/owner-invitations')
export class PlatformOwnerOnboardingController {
	constructor(
		private readonly onboarding: PlatformOwnerOnboardingService,
		private readonly delivery: OwnerInvitationDeliveryService,
	) {}

	@Post(':invitationId/delivery')
	@HttpCode(HttpStatus.ACCEPTED)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformPermissions(OWNER_INVITATION_PERMISSION.send)
	@RequirePlatformCsrf()
	@ApiParam({ name: 'organizationId', format: 'uuid' })
	@ApiParam({ name: 'invitationId', format: 'uuid' })
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Reserve audited owner-invitation email delivery',
		description:
			'Requires platform.organizations.owners.send-invitation, a live MFA platform session, exact administrator Origin and CSRF. Accepts no recipient, destination or token. A 202 reserves or reports the existing reservation; it does not confirm email receipt. A 503 means delivery prerequisites, persistence or durable auditing are unavailable and no success is confirmed. Delivery remains unavailable until all release gates are approved. UNCERTAIN requires operator review, never blind resend.',
	})
	@ApiAcceptedResponse({ type: OwnerInvitationDeliveryResponseDto })
	@ApiNotFoundResponse({ type: ApiErrorResponseDto })
	@ApiConflictResponse({ type: ApiErrorResponseDto })
	queueDelivery(
		@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
		@Param('invitationId', new ParseUUIDPipe()) invitationId: string,
		@Body() input: unknown,
		@Req() request: PlatformRequest,
	): Promise<OwnerInvitationDeliveryResponseDto> {
		if (
			input !== undefined &&
			(typeof input !== 'object' ||
				input === null ||
				Array.isArray(input) ||
				Object.keys(input).length !== 0)
		) {
			throw new BadRequestException({
				code: 'VALIDATION_FAILED',
				message: 'Delivery accepts no request fields.',
			});
		}
		return this.delivery.queue(
			this.context(request),
			request.platformPrincipal,
			organizationId,
			invitationId,
		);
	}

	@Post()
	@Header('Cache-Control', 'no-store')
	@RequirePlatformPermissions(OWNER_INVITATION_PERMISSION.invite)
	@RequirePlatformCsrf()
	@ApiParam({ name: 'organizationId', format: 'uuid' })
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Create a pending owner invitation',
		description:
			'Requires platform.organizations.owners.invite, exact admin Origin and CSRF. Creates PENDING_DELIVERY plus durable ownership audit atomically. It sends no email, returns no token and grants no identity, membership, OWNER role or tenant access. Persistence or audit failure returns 503 and rolls back the mutation.',
	})
	@ApiCreatedResponse({
		type: OwnerInvitationResponseDto,
		description: 'Pending-delivery invitation and audit event committed atomically.',
	})
	@ApiNotFoundResponse({ type: ApiErrorResponseDto })
	@ApiConflictResponse({ type: ApiErrorResponseDto })
	create(
		@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
		@Body() input: CreateOwnerInvitationDto,
		@Req() request: PlatformRequest,
	): Promise<OwnerInvitationResponseDto> {
		return this.onboarding.create(
			this.context(request),
			request.platformPrincipal,
			organizationId,
			input,
		);
	}

	@Get()
	@Header('Cache-Control', 'no-store')
	@RequirePlatformPermissions(OWNER_INVITATION_PERMISSION.read)
	@ApiParam({ name: 'organizationId', format: 'uuid' })
	@ApiOperation({
		summary: 'List one organization’s owner invitations',
		description:
			'Requires platform.organizations.owners.read. Organization-scoped only; default 20, maximum 50, optional allowlisted status, ordered by createdAt descending then UUID ascending. Responses never expose tokens or internal audit metadata.',
	})
	@ApiOkResponse({ type: OwnerInvitationListResponseDto })
	@ApiNotFoundResponse({ type: ApiErrorResponseDto })
	list(
		@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
		@Query() query: ListOwnerInvitationsQueryDto,
		@Req() request: PlatformRequest,
	): Promise<OwnerInvitationListResponseDto> {
		return this.onboarding.list(request.platformPrincipal, organizationId, query);
	}

	@Post(':invitationId/revocation')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformPermissions(OWNER_INVITATION_PERMISSION.revoke)
	@RequirePlatformCsrf()
	@ApiParam({ name: 'organizationId', format: 'uuid' })
	@ApiParam({ name: 'invitationId', format: 'uuid' })
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Revoke an outstanding owner invitation',
		description:
			'Requires platform.organizations.owners.revoke-invitation, exact admin Origin and CSRF. PENDING_DELIVERY or SENT becomes REVOKED with token material cleared and a durable audit in one transaction. Repeated or accepted revocation returns 409. No user, membership or OWNER assignment is changed. Persistence or audit failure returns 503 and rolls back the mutation.',
	})
	@ApiOkResponse({ type: OwnerInvitationResponseDto })
	@ApiNotFoundResponse({ type: ApiErrorResponseDto })
	@ApiConflictResponse({ type: ApiErrorResponseDto })
	revoke(
		@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
		@Param('invitationId', new ParseUUIDPipe()) invitationId: string,
		@Req() request: PlatformRequest,
	): Promise<OwnerInvitationResponseDto> {
		return this.onboarding.revoke(
			this.context(request),
			request.platformPrincipal,
			organizationId,
			invitationId,
		);
	}

	private context(request: PlatformRequest): OwnerInvitationMutationContext {
		if (request.platformPrincipal === undefined) throw new UnauthorizedException();
		return {
			actorPlatformStaffId: request.platformPrincipal.platformStaffId,
			requestId: request.requestId,
		};
	}
}
