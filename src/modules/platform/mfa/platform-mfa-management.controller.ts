import {
	Body,
	Controller,
	Delete,
	Get,
	Header,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Req,
	Res,
	UseGuards,
} from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiCookieAuth,
	ApiForbiddenResponse,
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiTooManyRequestsResponse,
	ApiUnauthorizedResponse,
	ApiConflictResponse,
	ApiNotFoundResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import { AccessBoundary } from '../../../common/security/route-access.decorator.js';
import { PlatformCookieService } from '../auth/platform-cookie.service.js';
import { PLATFORM_CSRF_HEADER } from '../auth/platform-auth.constants.js';
import { RequirePlatformCsrf } from '../auth/platform-csrf.decorator.js';
import { PlatformOriginCsrfGuard } from '../auth/platform-origin-csrf.guard.js';
import type { PlatformRequest } from '../auth/platform-request.js';
import { PlatformMfaManagementGuard } from './platform-mfa-management.guard.js';
import { PlatformMfaManagementService } from './platform-mfa-management.service.js';
import {
	PlatformFactorLabelDto,
	PlatformMfaFactorDto,
	PlatformMfaRecoveryCodesDto,
	PlatformMfaStateDto,
	PlatformStepUpStartDto,
	PlatformStepUpVerifyDto,
	PlatformTotpConfirmDto,
	PlatformTotpSetupDto,
} from './platform-mfa-management.dto.js';

@ApiTags('Platform MFA management')
@Controller('platform/auth')
@AccessBoundary('platform-mfa')
@UseGuards(PlatformOriginCsrfGuard, PlatformMfaManagementGuard)
@RequirePlatformCsrf()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@ApiCookieAuth('platform-session')
@ApiHeader({
	name: PLATFORM_CSRF_HEADER,
	required: true,
	description: 'Current platform CSRF proof.',
})
@ApiUnauthorizedResponse({
	type: ApiErrorResponseDto,
	description: 'The session or proof is invalid.',
})
@ApiForbiddenResponse({
	type: ApiErrorResponseDto,
	description: 'Origin, CSRF or recent verification is insufficient.',
})
@ApiBadRequestResponse({ type: ApiErrorResponseDto, description: 'Input is invalid.' })
@ApiConflictResponse({
	type: ApiErrorResponseDto,
	description: 'The change would violate MFA protection.',
})
@ApiNotFoundResponse({
	type: ApiErrorResponseDto,
	description: 'The owned authenticator is unavailable.',
})
@ApiTooManyRequestsResponse({
	type: ApiErrorResponseDto,
	description: 'Security attempt quota reached.',
})
@ApiServiceUnavailableResponse({
	type: ApiErrorResponseDto,
	description: 'Management, durable audit or notifications are unavailable.',
})
export class PlatformMfaManagementController {
	constructor(
		private readonly service: PlatformMfaManagementService,
		private readonly cookies: PlatformCookieService,
	) {}

	@Post('step-up/start')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 3, ttl: 60_000 } })
	@ApiOperation({
		summary: 'Start purpose-bound MFA reauthentication',
		description:
			'Requires current password and an eligible platform session. The HttpOnly step-up cookie is tied to this session, action and owned factor. Recovery sessions can request enrollment/replacement only; no new platform authority is granted.',
	})
	@ApiOkResponse({ type: PlatformMfaStateDto })
	async start(
		@Body() input: PlatformStepUpStartDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaStateDto> {
		const result = await this.service.start(this.session(request), input, request.requestId);
		this.cookies.setStepUp(response, result.token, result.expiresAt);
		return {
			status: result.verified ? 'operation_authorized' : 'step_up_required',
			expiresAt: result.expiresAt.toISOString(),
		};
	}

	@Post('step-up/verify')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 5, ttl: 60_000 } })
	@ApiOperation({
		summary: 'Verify the existing factor for one sensitive action',
		description:
			'Verifies an active TOTP, or a separate unused recovery code for authenticator repair only. Five-minute expiry and five attempts. Does not issue or upgrade a general platform session.',
	})
	@ApiOkResponse({ type: PlatformMfaStateDto })
	async verify(
		@Body() input: PlatformStepUpVerifyDto,
		@Req() request: PlatformRequest,
	): Promise<PlatformMfaStateDto> {
		await this.service.verify(this.session(request), this.proof(request), input, request.requestId);
		return { status: 'operation_authorized' };
	}

	@Get('mfa/factors')
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'List this platform identity’s authenticator metadata',
		description:
			'Returns only the current TOTP slot and safe lifecycle metadata. Recovery sessions can inspect only their own factor. Never returns secret, encryption, recovery-code or pending-proof material.',
	})
	@ApiOkResponse({ type: PlatformMfaFactorDto, isArray: true })
	list(@Req() request: PlatformRequest): Promise<PlatformMfaFactorDto[]> {
		return this.service.list(this.session(request));
	}

	@Post('mfa/totp/enroll')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Begin a verified platform TOTP enrollment',
		description:
			'Requires an unused totp_enroll step-up proof and no active TOTP. Returns provisioning material once. It never activates a factor or a pending bootstrap owner.',
	})
	@ApiOkResponse({ type: PlatformTotpSetupDto })
	enroll(
		@Body() input: PlatformFactorLabelDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformTotpSetupDto> {
		return this.setup(request, response, input.label);
	}

	@Post('mfa/totp/confirm')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 5, ttl: 60_000 } })
	@ApiOperation({
		summary: 'Confirm a pending TOTP enrollment',
		description:
			'Requires this session’s unexpired enrollment cookie and a valid code from the new factor. Commits activation, old-session/proof invalidation, new recovery codes, audit and notification atomically. Requires fresh TOTP login afterward.',
	})
	@ApiOkResponse({ type: PlatformMfaRecoveryCodesDto })
	confirm(
		@Body() input: PlatformTotpConfirmDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaRecoveryCodesDto> {
		return this.finish(request, response, input.code);
	}

	@Post('mfa/factors/:id/replace')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Start replacement of an owned platform authenticator',
		description:
			'Requires a verified totp_replace step-up proof for this factor. The old secret remains active until confirmation commits. Never accepts a replacement user or staff identity.',
	})
	@ApiOkResponse({ type: PlatformTotpSetupDto })
	replace(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() input: PlatformFactorLabelDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformTotpSetupDto> {
		return this.setup(request, response, input.label, id);
	}

	@Post('mfa/factors/:id/replace/confirm')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 5, ttl: 60_000 } })
	@ApiOperation({
		summary: 'Confirm a replacement authenticator',
		description:
			'Requires proof from the new authenticator and the replacement cookie for this session and factor. Old secret, sessions and recovery set cease to work only when the replacement transaction commits.',
	})
	@ApiOkResponse({ type: PlatformMfaRecoveryCodesDto })
	confirmReplacement(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() input: PlatformTotpConfirmDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaRecoveryCodesDto> {
		return this.finish(request, response, input.code, id);
	}

	@Patch('mfa/factors/:id')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Rename an owned authenticator',
		description:
			'Consumes a factor_rename proof for this factor. Changes only its bounded display label; cryptographic material and assurance remain unchanged.',
	})
	@ApiOkResponse({ type: PlatformMfaStateDto })
	async rename(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() input: PlatformFactorLabelDto,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaStateDto> {
		await this.service.rename(
			this.session(request),
			this.proof(request),
			id,
			input.label,
			request.requestId,
		);
		this.cookies.clearStepUp(response);
		return { status: 'renamed' };
	}

	@Delete('mfa/factors/:id')
	@Header('Cache-Control', 'no-store')
	@ApiOperation({
		summary: 'Protect the final required platform authenticator',
		description:
			'Requires a totp_remove proof. Current policy permits one TOTP slot, so removal always returns AUTH_MFA_FACTOR_CHANGE_DENIED. Recovery codes never justify disabling the final factor; use verified replacement.',
	})
	async remove(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<never> {
		try {
			return await this.service.remove(
				this.session(request),
				this.proof(request),
				id,
				request.requestId,
			);
		} finally {
			this.cookies.clearStepUp(response);
		}
	}

	@Post('mfa/recovery-codes/regenerate')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 3, ttl: 60_000 } })
	@ApiOperation({
		summary: 'Replace the platform recovery-code set',
		description:
			'Consumes a recovery_regenerate proof verified with current password and active TOTP. Invalidates all prior unused codes and platform sessions atomically. Returns ten high-entropy codes once; no retrieval endpoint exists.',
	})
	@ApiOkResponse({ type: PlatformMfaRecoveryCodesDto })
	async regenerate(
		@Req() request: PlatformRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<PlatformMfaRecoveryCodesDto> {
		const recoveryCodes = await this.service.regenerate(
			this.session(request),
			this.proof(request),
			request.requestId,
		);
		this.cookies.clearSession(response);
		return { status: 'reauthentication_required', recoveryCodes };
	}

	private async setup(
		request: PlatformRequest,
		response: Response,
		label: string,
		factorId?: string,
	): Promise<PlatformTotpSetupDto> {
		const result = await this.service.enroll(
			this.session(request),
			this.proof(request),
			label,
			factorId,
			request.requestId,
		);
		this.cookies.setStepUp(response, result.token, result.expiresAt);
		return {
			secret: result.secret,
			enrollmentUri: result.enrollmentUri,
			expiresAt: result.expiresAt.toISOString(),
		};
	}

	private async finish(
		request: PlatformRequest,
		response: Response,
		code: string,
		factorId?: string,
	): Promise<PlatformMfaRecoveryCodesDto> {
		const recoveryCodes = await this.service.confirm(
			this.session(request),
			this.proof(request),
			code,
			factorId,
			request.requestId,
		);
		this.cookies.clearSession(response);
		return { status: 'reauthentication_required', recoveryCodes };
	}

	private session(request: PlatformRequest): string {
		const token = this.cookies.readSession(request);
		if (token === undefined) throw new ApiProblemException('UNAUTHENTICATED');
		return token;
	}

	private proof(request: PlatformRequest): string {
		const token = this.cookies.readStepUp(request);
		if (token === undefined) throw new ApiProblemException('AUTH_REAUTHENTICATION_REQUIRED');
		return token;
	}
}
