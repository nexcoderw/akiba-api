import { Body, Controller, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiBody,
	ApiCookieAuth,
	ApiForbiddenResponse,
	ApiHeader,
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

import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import { AccessBoundary } from '../../../common/security/route-access.decorator.js';
import { PlatformCookieService } from '../auth/platform-cookie.service.js';
import { RequirePlatformCsrf } from '../auth/platform-csrf.decorator.js';
import { PlatformOriginCsrfGuard } from '../auth/platform-origin-csrf.guard.js';
import type { PlatformRequest } from '../auth/platform-request.js';
import { PlatformTokenService } from '../auth/platform-token.service.js';
import {
	PlatformOwnerCompleteDto,
	PlatformOwnerExchangeDto,
	PlatformOwnerPasswordDto,
	PlatformOwnerRecoveryDto,
	PlatformOwnerSetupDto,
	PlatformOwnerStateDto,
} from './dto/platform-owner-enrollment.dto.js';
import { PlatformOwnerEnrollmentService } from './platform-owner-enrollment.service.js';

@ApiTags('Platform owner enrollment')
@Controller('platform/bootstrap/enrollment')
@AccessBoundary('public')
@UseGuards(PlatformOriginCsrfGuard)
@Throttle({ default: { limit: 5, ttl: 60_000 } })
@ApiBadRequestResponse({ type: ApiErrorResponseDto, description: 'Malformed or unexpected input.' })
@ApiUnauthorizedResponse({
	type: ApiErrorResponseDto,
	description: 'Invalid, superseded, exhausted or expired enrollment proof.',
})
@ApiForbiddenResponse({ type: ApiErrorResponseDto, description: 'Origin or CSRF rejected.' })
@ApiTooManyRequestsResponse({
	type: ApiErrorResponseDto,
	description: 'Bounded enrollment rate exceeded.',
})
@ApiServiceUnavailableResponse({
	type: ApiErrorResponseDto,
	description: 'Bootstrap disabled or persistence unavailable.',
})
export class PlatformOwnerEnrollmentController {
	constructor(
		private readonly enrollment: PlatformOwnerEnrollmentService,
		private readonly cookies: PlatformCookieService,
		private readonly tokens: PlatformTokenService,
	) {}

	@Post('exchange')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Exchange a delivered first-owner setup code',
		description:
			'Exact admin Origin required. Exchanges a single-use mailbox proof for an origin-sealed HttpOnly setup cookie and readable CSRF cookie. No platform session or privileges are issued.',
	})
	@ApiOkResponse({ type: PlatformOwnerStateDto })
	async exchange(
		@Body() input: PlatformOwnerExchangeDto,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformOwnerStateDto> {
		const result = await this.enrollment.exchange(input.token);
		this.cookies.setChallenge(response, result.token, new Date(result.expiresAt));
		this.cookies.setCsrf(response, this.tokens.createToken(), new Date(result.expiresAt));
		return { stage: result.stage, expiresAt: result.expiresAt };
	}

	@Post('status')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformCsrf()
	@ApiCookieAuth('platform-challenge')
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Read first-owner setup progress',
		description:
			'Requires the restricted setup cookie, exact admin Origin and CSRF. Returns only stage and expiry; never secrets.',
	})
	@ApiOkResponse({ type: PlatformOwnerStateDto })
	@ApiBody({ schema: { type: 'object', additionalProperties: false } })
	status(@Body() input: unknown, @Req() request: PlatformRequest): Promise<PlatformOwnerStateDto> {
		this.empty(input);
		return this.enrollment.status(this.proof(request));
	}

	@Post('password')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformCsrf()
	@ApiCookieAuth('platform-challenge')
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Choose the pending owner password',
		description:
			'Restricted setup proof and CSRF required. Applies canonical password policy and bounded Argon2id hashing. Password remains pending until confirmed MFA activates the identity.',
	})
	@ApiOkResponse({ type: PlatformOwnerStateDto })
	password(
		@Body() input: PlatformOwnerPasswordDto,
		@Req() request: PlatformRequest,
	): Promise<PlatformOwnerStateDto> {
		return this.enrollment.password(this.proof(request), input.password, request.requestId);
	}

	@Post('setup')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformCsrf()
	@ApiCookieAuth('platform-challenge')
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Generate a first-owner authenticator key',
		description:
			'Restricted setup proof and CSRF required after password setup. Each explicit request supersedes the prior key. At most three generations, with no reset of the total five verification attempts.',
	})
	@ApiOkResponse({ type: PlatformOwnerSetupDto })
	@ApiBody({ schema: { type: 'object', additionalProperties: false } })
	setup(@Body() input: unknown, @Req() request: PlatformRequest): Promise<PlatformOwnerSetupDto> {
		this.empty(input);
		return this.enrollment.setup(this.proof(request));
	}

	@Post('complete')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformCsrf()
	@ApiCookieAuth('platform-challenge')
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Activate the reserved platform owner',
		description:
			'Restricted setup proof, CSRF and latest version/current TOTP required. Atomically verifies mailbox, creates password/factor, activates the sole reserved system owner, records audits and returns recovery codes once. Clears all platform cookies; normal password/MFA sign-in is required afterward.',
	})
	@ApiOkResponse({ type: PlatformOwnerRecoveryDto })
	async complete(
		@Body() input: PlatformOwnerCompleteDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformOwnerRecoveryDto> {
		const result = await this.enrollment.complete(
			this.proof(request),
			input.code,
			input.version,
			request.requestId,
		);
		this.cookies.clearSession(response);
		return result;
	}

	@Post('cancel')
	@HttpCode(204)
	@Header('Cache-Control', 'no-store')
	@RequirePlatformCsrf()
	@ApiCookieAuth('platform-challenge')
	@ApiHeader({ name: 'x-platform-csrf-token', required: true })
	@ApiOperation({
		summary: 'Cancel first-owner setup',
		description:
			'Restricted setup cookie, exact Origin and CSRF required. Invalidates the setup proof and clears all platform cookies; a new operator email is required to restart.',
	})
	@ApiNoContentResponse({ description: 'Setup cancelled; platform cookies cleared.' })
	@ApiBody({ schema: { type: 'object', additionalProperties: false } })
	async cancel(
		@Body() input: unknown,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<void> {
		this.empty(input);
		try {
			await this.enrollment.cancel(this.proof(request));
		} finally {
			this.cookies.clearSession(response);
		}
	}

	private proof(request: PlatformRequest): string {
		const token = this.cookies.readChallenge(request);
		if (token === undefined) throw new ApiProblemException('AUTH_MFA_INVALID');
		return token;
	}

	private empty(input: unknown): void {
		if (
			input === null ||
			typeof input !== 'object' ||
			Array.isArray(input) ||
			Object.keys(input).length !== 0
		)
			throw new ApiProblemException('VALIDATION_FAILED');
	}
}
