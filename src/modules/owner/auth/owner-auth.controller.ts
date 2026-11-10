import {
	Body,
	Controller,
	Get,
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
	ApiCookieAuth,
	ApiForbiddenResponse,
	ApiNoContentResponse,
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
import {
	OwnerAuthenticatedResponseDto,
	OwnerSessionResponseDto,
} from './dto/owner-auth-response.dto.js';
import { OwnerLoginDto } from './dto/owner-login.dto.js';
import { OWNER_AUTH_ERROR } from './owner-auth.constants.js';
import { OwnerCookieService } from './owner-cookie.service.js';
import { RequireOwnerCsrf } from './owner-csrf.decorator.js';
import { OwnerLoginService } from './owner-login.service.js';
import { OwnerOriginCsrfGuard } from './owner-origin-csrf.guard.js';
import type { OwnerRequest } from './owner-request.js';
import { OwnerSessionGuard } from './owner-session.guard.js';
import { OwnerSessionService } from './owner-session.service.js';
import { OwnerTokenService } from './owner-token.service.js';

@ApiTags('Owner authentication')
@Controller('owner/auth')
export class OwnerAuthController {
	constructor(
		private readonly loginService: OwnerLoginService,
		private readonly sessions: OwnerSessionService,
		private readonly cookies: OwnerCookieService,
		private readonly tokens: OwnerTokenService,
	) {}

	@AccessBoundary('public')
	@Post('login')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@UseGuards(OwnerOriginCsrfGuard)
	@ApiOperation({
		summary: 'Sign in to the Organization Portal',
		description:
			'Authenticates an active verified non-platform identity with a live OWNER membership and issues a separate host-only owner session.',
	})
	@ApiOkResponse({ type: OwnerAuthenticatedResponseDto })
	@ApiBadRequestResponse({ type: ApiErrorResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	async login(
		@Body() input: OwnerLoginDto,
		@Req() request: OwnerRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<OwnerAuthenticatedResponseDto> {
		const result = await this.loginService.login(
			input,
			request.socket.remoteAddress ?? 'unavailable',
			undefined,
			request.ownerOrganizationSlug,
		);
		const csrfToken = this.tokens.create();
		this.cookies.setSession(response, result.sessionToken, result.expiresAtDate, request.headers.origin ?? '');
		this.cookies.setCsrf(response, csrfToken, result.expiresAtDate);
		return { status: 'authenticated', expiresAt: result.expiresAt, csrfToken };
	}

	@AccessBoundary('owner-session')
	@Get('session')
	@Header('Cache-Control', 'no-store')
	@UseGuards(OwnerOriginCsrfGuard, OwnerSessionGuard)
	@ApiCookieAuth('owner-session')
	@ApiOperation({
		summary: 'Read the current owner session and live organization access',
		description:
			'Revalidates the global identity, password state, session expiry, active memberships, roles, and current organization lifecycle state.',
	})
	@ApiOkResponse({ type: OwnerSessionResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	getSession(@Req() request: OwnerRequest): OwnerSessionResponseDto {
		const principal = request.ownerPrincipal;
		if (principal === undefined) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		return {
			userId: principal.userId,
			displayName: principal.displayName,
			email: principal.email,
			assurance: principal.assurance === 'AAL2' ? 'aal2' : 'aal1',
			expiresAt: principal.expiresAt.toISOString(),
			organizations: principal.organizations.map((organization) => ({
				...organization,
				roles: [...organization.roles],
			})),
		};
	}

	@AccessBoundary('public')
	@Post('logout')
	@HttpCode(HttpStatus.NO_CONTENT)
	@Header('Cache-Control', 'no-store')
	@UseGuards(OwnerOriginCsrfGuard)
	@RequireOwnerCsrf()
	@ApiCookieAuth('owner-session')
	@ApiOperation({ summary: 'Revoke the presented owner session' })
	@ApiNoContentResponse()
	@ApiForbiddenResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	async logout(
		@Req() request: OwnerRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<void> {
		await this.sessions.revoke(this.cookies.readSession(request));
		this.cookies.clear(response);
	}
}
