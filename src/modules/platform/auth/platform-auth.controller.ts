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
	ApiPreconditionFailedResponse,
	ApiServiceUnavailableResponse,
	ApiTooManyRequestsResponse,
	ApiUnauthorizedResponse,
	ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { AccessBoundary } from '../../../common/security/route-access.decorator.js';
import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import {
	PlatformMfaChallengeResponseDto,
	PlatformMfaVerifiedResponseDto,
	PlatformSessionResponseDto,
	PlatformEmailOtpSentResponseDto,
} from './dto/platform-auth-response.dto.js';
import { PlatformLoginDto } from './dto/platform-login.dto.js';
import { PlatformMfaVerifyDto } from './dto/platform-mfa-verify.dto.js';
import { PlatformEmailOtpRequestDto } from './dto/platform-email-otp-request.dto.js';
import { PlatformEmailOtpService } from './platform-email-otp.service.js';
import { RequirePlatformCsrf } from './platform-csrf.decorator.js';
import { PLATFORM_AUTH_ERROR } from './platform-auth.constants.js';
import { PlatformCookieService } from './platform-cookie.service.js';
import { PlatformLoginService } from './platform-login.service.js';
import { PlatformMfaService } from './platform-mfa.service.js';
import { PlatformOriginCsrfGuard } from './platform-origin-csrf.guard.js';
import type { PlatformRequest } from './platform-request.js';
import { PlatformSessionGuard } from './platform-session.guard.js';
import { PlatformSessionService } from './platform-session.service.js';
import { PlatformTokenService } from './platform-token.service.js';

@ApiTags('Platform authentication')
@Controller('platform/auth')
export class PlatformAuthController {
	constructor(
		private readonly loginService: PlatformLoginService,
		private readonly mfaService: PlatformMfaService,
		private readonly sessionService: PlatformSessionService,
		private readonly cookies: PlatformCookieService,
		private readonly tokens: PlatformTokenService,
		private readonly emailOtp: PlatformEmailOtpService,
	) {}

	@AccessBoundary('public')
	@Post('login')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@UseGuards(PlatformOriginCsrfGuard)
	@ApiOperation({
		summary: 'Start platform administrator authentication',
		description:
			'Validates an eligible administrator password and creates a short-lived MFA challenge. It never creates an authenticated session.',
	})
	@ApiOkResponse({
		description: 'An MFA challenge was created.',
		type: PlatformMfaChallengeResponseDto,
	})
	@ApiBadRequestResponse({ description: 'The request DTO is invalid.', type: ApiErrorResponseDto })
	@ApiUnauthorizedResponse({ description: 'Authentication failed.', type: ApiErrorResponseDto })
	@ApiForbiddenResponse({
		description: 'The administrative Origin is not allowed.',
		type: ApiErrorResponseDto,
	})
	@ApiPreconditionFailedResponse({
		description: 'Confirmed MFA enrollment is required.',
		type: ApiErrorResponseDto,
	})
	@ApiTooManyRequestsResponse({
		description: 'Authentication attempts are rate limited.',
		type: ApiErrorResponseDto,
	})
	@ApiServiceUnavailableResponse({
		description: 'Login persistence could not be confirmed.',
		type: ApiErrorResponseDto,
	})
	async login(
		@Body() input: PlatformLoginDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaChallengeResponseDto> {
		const result = await this.loginService.login(
			input,
			request.socket.remoteAddress ?? 'unavailable',
		);
		this.cookies.setCsrf(response, result.csrfToken, new Date(result.expiresAt));
		return result;
	}

	@AccessBoundary('public')
	@Post('mfa/email')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 3, ttl: 60_000 } })
	@UseGuards(PlatformOriginCsrfGuard)
	@RequirePlatformCsrf()
	@ApiOperation({
		summary: 'Send an email verification code',
		description:
			'Requires a live password challenge and CSRF proof. Opt-in fallback delivered only to the verified account mailbox; never accepts a recipient. Three sends per challenge, sixty-second cooldown, expiry at most five minutes. No session is issued.',
	})
	@ApiOkResponse({ type: PlatformEmailOtpSentResponseDto })
	@ApiBadRequestResponse({ type: ApiErrorResponseDto, description: 'Invalid challenge input.' })
	@ApiUnauthorizedResponse({
		type: ApiErrorResponseDto,
		description: 'Challenge is invalid or email verification is disabled.',
	})
	@ApiForbiddenResponse({
		type: ApiErrorResponseDto,
		description: 'Origin or CSRF proof is invalid.',
	})
	@ApiTooManyRequestsResponse({
		type: ApiErrorResponseDto,
		description: 'Send cooldown or request quota reached.',
	})
	@ApiServiceUnavailableResponse({
		type: ApiErrorResponseDto,
		description: 'Delivery could not be confirmed.',
	})
	sendEmailOtp(
		@Body() input: PlatformEmailOtpRequestDto,
	): Promise<PlatformEmailOtpSentResponseDto> {
		return this.emailOtp.send(input.challengeToken);
	}

	@AccessBoundary('public')
	@Post('mfa/verify')
	@HttpCode(HttpStatus.OK)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@UseGuards(PlatformOriginCsrfGuard)
	@RequirePlatformCsrf()
	@ApiOperation({
		summary: 'Complete platform administrator MFA',
		description:
			'Consumes one MFA challenge and a valid authenticator step, recovery code or enabled email OTP before issuing a host-only HttpOnly session cookie.',
	})
	@ApiOkResponse({
		description: 'MFA succeeded and the session cookie was issued.',
		type: PlatformMfaVerifiedResponseDto,
	})
	@ApiBadRequestResponse({ description: 'The request DTO is invalid.', type: ApiErrorResponseDto })
	@ApiUnauthorizedResponse({
		description: 'The challenge or MFA factor is invalid.',
		type: ApiErrorResponseDto,
	})
	@ApiForbiddenResponse({
		description: 'Origin or CSRF validation failed.',
		type: ApiErrorResponseDto,
	})
	@ApiTooManyRequestsResponse({
		description: 'The caller exceeded the request limit.',
		type: ApiErrorResponseDto,
	})
	@ApiServiceUnavailableResponse({
		description: 'MFA persistence could not be confirmed.',
		type: ApiErrorResponseDto,
	})
	async verifyMfa(
		@Body() input: PlatformMfaVerifyDto,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaVerifiedResponseDto> {
		const result = await this.mfaService.verify(input);
		const csrfToken = this.tokens.createToken();
		this.cookies.setSession(response, result.sessionToken, result.expiresAtDate);
		this.cookies.setCsrf(response, csrfToken, result.expiresAtDate);
		return { status: result.status, expiresAt: result.expiresAt, csrfToken };
	}

	@AccessBoundary('platform-session')
	@Get('session')
	@Header('Cache-Control', 'no-store')
	@UseGuards(PlatformOriginCsrfGuard, PlatformSessionGuard)
	@ApiCookieAuth('platform-session')
	@ApiOperation({
		summary: 'Read the current platform administrator session',
		description:
			'Revalidates expiry, idle timeout, password state, administrator eligibility, and current database permissions.',
	})
	@ApiOkResponse({
		description: 'Current safe session information.',
		type: PlatformSessionResponseDto,
	})
	@ApiUnauthorizedResponse({
		description: 'The session is missing, invalid, or expired.',
		type: ApiErrorResponseDto,
	})
	@ApiForbiddenResponse({
		description: 'The administrative Origin is not allowed.',
		type: ApiErrorResponseDto,
	})
	@ApiTooManyRequestsResponse({
		description: 'The caller exceeded the request limit.',
		type: ApiErrorResponseDto,
	})
	getSession(@Req() request: PlatformRequest): PlatformSessionResponseDto {
		const principal = request.platformPrincipal;
		if (principal === undefined) {
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidSession);
		}
		return {
			userId: principal.userId,
			displayName: principal.displayName,
			email: principal.email,
			platformStaffId: principal.platformStaffId,
			expiresAt: principal.expiresAt.toISOString(),
			roles: [...principal.roles],
			permissions: [...principal.permissions],
		};
	}

	@AccessBoundary('public')
	@Post('logout')
	@HttpCode(HttpStatus.NO_CONTENT)
	@Header('Cache-Control', 'no-store')
	@UseGuards(PlatformOriginCsrfGuard)
	@RequirePlatformCsrf()
	@ApiCookieAuth('platform-session')
	@ApiOperation({
		summary: 'End the current platform administrator session',
		description:
			'Revokes only the presented session digest and clears the matching host-only session cookie. Repeated requests are safe.',
	})
	@ApiNoContentResponse({ description: 'The presented session is revoked or was already absent.' })
	@ApiForbiddenResponse({
		description: 'Origin or CSRF validation failed.',
		type: ApiErrorResponseDto,
	})
	@ApiTooManyRequestsResponse({
		description: 'The caller exceeded the request limit.',
		type: ApiErrorResponseDto,
	})
	async logout(
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<void> {
		await this.sessionService.revoke(this.cookies.readSession(request));
		this.cookies.clearSession(response);
	}
}
