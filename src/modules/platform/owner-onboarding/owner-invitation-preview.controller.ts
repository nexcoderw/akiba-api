import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiTooManyRequestsResponse,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AccessBoundary } from '../../../common/security/route-access.decorator.js';
import { ApiErrorResponseDto } from '../../../common/dto/api-error-response.dto.js';
import {
	OwnerInvitationPreviewDto,
	OwnerInvitationPreviewResponseDto,
} from './dto/owner-invitation-delivery.dto.js';
import { OwnerInvitationDeliveryService } from './owner-invitation-delivery.service.js';

@ApiTags('Owner invitation preview')
@Controller('owner-invitations')
export class OwnerInvitationPreviewController {
	constructor(private readonly delivery: OwnerInvitationDeliveryService) {}

	@AccessBoundary('public')
	@Post('preview')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@ApiOperation({
		summary: 'Preview a sent owner invitation without authenticating its recipient',
		description:
			'Bounded opaque token in POST body only. Returns the organization name, never recipient/account details or cookies. Invalid, expired, revoked, accepted and ineligible invitations share one invalid response. No account, membership, enrollment proof or session is created. Disabled until database and acceptance-destination review.',
	})
	@ApiOkResponse({ type: OwnerInvitationPreviewResponseDto })
	@ApiBadRequestResponse({ type: ApiErrorResponseDto })
	@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
	@ApiTooManyRequestsResponse({ type: ApiErrorResponseDto })
	@ApiServiceUnavailableResponse({ type: ApiErrorResponseDto })
	preview(@Body() input: OwnerInvitationPreviewDto): Promise<OwnerInvitationPreviewResponseDto> {
		return this.delivery.preview(input.token);
	}
}
