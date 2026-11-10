import {
	Body,
	Controller,
	Header,
	HttpCode,
	HttpStatus,
	Post,
	Req,
	Res,
	UnauthorizedException,
	UseGuards,
} from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiConflictResponse,
	ApiCookieAuth,
	ApiCreatedResponse,
	ApiForbiddenResponse,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiTooManyRequestsResponse,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { AccessBoundary } from '../../../common/security/route-access.decorator.js';
import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import { OWNER_AUTH_ERROR } from '../auth/owner-auth.constants.js';
import { OwnerCookieService } from '../auth/owner-cookie.service.js';
import { RequireOwnerCsrf } from '../auth/owner-csrf.decorator.js';
import { OwnerOriginCsrfGuard } from '../auth/owner-origin-csrf.guard.js';
import type { OwnerRequest } from '../auth/owner-request.js';
import { OwnerTokenService } from '../auth/owner-token.service.js';
import {
	AcceptOwnerInvitationDto,
	RegisterInvitedOwnerDto,
	StartOwnerEnrollmentDto,
	VerifyExistingOwnerDto,
} from './dto/owner-enrollment.dto.js';
import {
	OwnerEnrollmentAuthenticatedResponseDto,
	OwnerEnrollmentChallengeResponseDto,
	OwnerInvitationAcceptedResponseDto,
} from './dto/owner-enrollment-response.dto.js';
import { OwnerAcceptanceService } from './owner-acceptance.service.js';
import { OwnerEnrollmentService } from './owner-enrollment.service.js';
import { OwnerEnrollmentSessionGuard } from './owner-enrollment-session.guard.js';

@ApiTags('Owner enrollment')
@Controller()
export class OwnerEnrollmentController {
	constructor(
		private readonly enrollment: OwnerEnrollmentService,
		private readonly acceptance: OwnerAcceptanceService,
		private readonly cookies: OwnerCookieService,
		private readonly tokens: OwnerTokenService,
	) {}

	@AccessBoundary('public')
	@Post('owner-enrollment/challenges')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@UseGuards(OwnerOriginCsrfGuard)
	@ApiOperation({
		summary: 'Start invitation-bound owner enrollment',
		description:
			'Validates the delivered invitation and creates one short-lived, purpose-scoped proof. Account existence is never exposed by public preview.',
	})
	@ApiOkResponse({ type: OwnerEnrollmentChallengeResponseDto })
	@ApiBadRequestResponse({ type: ApiErrorResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	start(
		@Body() input: StartOwnerEnrollmentDto,
		@Req() request: OwnerRequest,
	): Promise<OwnerEnrollmentChallengeResponseDto> {
		return this.enrollment.start(input.invitationToken, undefined, request.ownerOrganizationSlug);
	}

	@AccessBoundary('public')
	@Post('owner/auth/verify')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@UseGuards(OwnerOriginCsrfGuard)
	@ApiOperation({ summary: 'Authenticate the existing invitation recipient' })
	@ApiOkResponse({ type: OwnerEnrollmentAuthenticatedResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	async verify(
		@Body() input: VerifyExistingOwnerDto,
		@Req() request: OwnerRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<OwnerEnrollmentAuthenticatedResponseDto> {
		return this.setAuthenticated(
			response,
			request.headers.origin ?? '',
			await this.enrollment.verifyExisting(input, undefined, request.ownerOrganizationSlug),
		);
	}

	@AccessBoundary('public')
	@Post('owner-enrollment/registrations')
	@HttpCode(HttpStatus.CREATED)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 5, ttl: 60_000 } })
	@UseGuards(OwnerOriginCsrfGuard)
	@ApiOperation({ summary: 'Create the invited owner identity after mailbox proof' })
	@ApiCreatedResponse({ type: OwnerEnrollmentAuthenticatedResponseDto })
	@ApiBadRequestResponse({ type: ApiErrorResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiConflictResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	async register(
		@Body() input: RegisterInvitedOwnerDto,
		@Req() request: OwnerRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<OwnerEnrollmentAuthenticatedResponseDto> {
		return this.setAuthenticated(
			response,
			request.headers.origin ?? '',
			await this.enrollment.register(input, undefined, request.ownerOrganizationSlug),
		);
	}

	@AccessBoundary('owner-enrollment')
	@Post('owner-enrollment/acceptances')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@UseGuards(OwnerOriginCsrfGuard, OwnerEnrollmentSessionGuard)
	@RequireOwnerCsrf()
	@ApiCookieAuth('owner-session')
	@ApiOperation({
		summary: 'Atomically accept a verified owner invitation',
		description:
			'Consumes the proof and invitation, activates the safe membership, assigns the exact system OWNER role, and records recipient audit evidence in one transaction.',
	})
	@ApiOkResponse({ type: OwnerInvitationAcceptedResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiConflictResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	accept(
		@Body() input: AcceptOwnerInvitationDto,
		@Req() request: OwnerRequest,
	): Promise<OwnerInvitationAcceptedResponseDto> {
		const principal = request.ownerPrincipal;
		if (principal === undefined) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		return this.acceptance.accept(
			principal,
			input.challengeToken,
			request.requestId,
			undefined,
			request.ownerOrganizationSlug,
		);
	}

	private setAuthenticated(
		response: Response,
		origin: string,
		result: {
			readonly status: 'verified';
			readonly expiresAt: string;
			readonly expiresAtDate: Date;
			readonly sessionToken: string;
		},
	): OwnerEnrollmentAuthenticatedResponseDto {
		const csrfToken = this.tokens.create();
		this.cookies.setSession(response, result.sessionToken, result.expiresAtDate, origin);
		this.cookies.setCsrf(response, csrfToken, result.expiresAtDate);
		return { status: result.status, expiresAt: result.expiresAt, csrfToken };
	}
}
