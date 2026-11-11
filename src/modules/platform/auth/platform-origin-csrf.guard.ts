import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import {
	localRequestAuthority,
	requestAuthority,
} from '../../../common/security/request-authority.js';
import { PLATFORM_CSRF_HEADER } from './platform-auth.constants.js';
import { PLATFORM_CSRF_REQUIRED_METADATA } from './platform-csrf.decorator.js';
import { PlatformCookieService } from './platform-cookie.service.js';
import type { PlatformRequest } from './platform-request.js';
import { PlatformTokenService } from './platform-token.service.js';

@Injectable()
export class PlatformOriginCsrfGuard implements CanActivate {
	private readonly allowedOrigin: string;
	private readonly api: URL;
	private readonly production: boolean;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly reflector: Reflector,
		private readonly cookies: PlatformCookieService,
		private readonly tokens: PlatformTokenService,
	) {
		this.allowedOrigin = config.get('PLATFORM_ADMIN_ORIGIN', { infer: true });
		this.api = new URL(config.get('API_PUBLIC_ORIGIN', { infer: true }));
		this.production = config.get('NODE_ENV', { infer: true }) === 'production';
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<PlatformRequest>();
		const authority = requestAuthority(request);
		if (
			request.headers.origin !== this.allowedOrigin ||
			authority === null ||
			(authority !== this.api.host &&
				authority !== new URL(this.allowedOrigin).host &&
				(this.production || !localRequestAuthority(request, authority, this.api)))
		) {
			throw new ForbiddenException({
				code: 'PLATFORM_ORIGIN_REJECTED',
				message: 'The request origin is not allowed',
			});
		}

		const csrfRequired = this.reflector.getAllAndOverride<boolean>(
			PLATFORM_CSRF_REQUIRED_METADATA,
			[context.getHandler(), context.getClass()],
		);
		if (!csrfRequired) {
			return true;
		}

		const cookieToken = this.cookies.readCsrf(request);
		const header = request.headers[PLATFORM_CSRF_HEADER];
		const headerToken = Array.isArray(header) ? undefined : header;
		if (
			cookieToken === undefined ||
			headerToken === undefined ||
			!this.tokens.equal(cookieToken, headerToken)
		) {
			throw new ForbiddenException({
				code: 'PLATFORM_CSRF_REJECTED',
				message: 'The CSRF token is missing or invalid',
			});
		}
		return true;
	}
}
