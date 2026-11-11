import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'cookie';
import type { Request, Response } from 'express';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import {
	LOCAL_PLATFORM_CSRF_COOKIE,
	LOCAL_PLATFORM_SESSION_COOKIE,
	LOCAL_PLATFORM_CHALLENGE_COOKIE,
	PLATFORM_CHALLENGE_COOKIE,
	PLATFORM_CSRF_COOKIE,
	PLATFORM_SESSION_COOKIE,
} from './platform-auth.constants.js';
import { PlatformTokenService } from './platform-token.service.js';

@Injectable()
export class PlatformCookieService {
	private readonly secure: boolean;
	private readonly sessionCookieName: string;
	private readonly csrfCookieName: string;
	private readonly challengeCookieName: string;
	private readonly origin: string;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly tokens: PlatformTokenService,
	) {
		this.secure = config.get('PLATFORM_AUTH_COOKIE_SECURE', { infer: true });
		this.sessionCookieName = this.secure ? PLATFORM_SESSION_COOKIE : LOCAL_PLATFORM_SESSION_COOKIE;
		this.csrfCookieName = this.secure ? PLATFORM_CSRF_COOKIE : LOCAL_PLATFORM_CSRF_COOKIE;
		this.challengeCookieName = this.secure
			? PLATFORM_CHALLENGE_COOKIE
			: LOCAL_PLATFORM_CHALLENGE_COOKIE;
		this.origin = config.get('PLATFORM_ADMIN_ORIGIN', { infer: true });
	}

	readChallenge(request: Request): string | undefined {
		const value = this.readCookie(request, this.challengeCookieName);
		if (value === undefined || value.length > 340 || request.headers.origin !== this.origin)
			return undefined;
		const [version, token, signature, extra] = value.split('.');
		if (
			version !== 'v1' ||
			token === undefined ||
			!/^[A-Za-z0-9_-]{32,256}$/u.test(token) ||
			signature === undefined ||
			extra !== undefined ||
			!this.tokens.equal(signature, this.challengeSignature(token))
		)
			return undefined;
		return token;
	}

	setChallenge(response: Response, token: string, expiresAt: Date): void {
		response.cookie(this.challengeCookieName, `v1.${token}.${this.challengeSignature(token)}`, {
			expires: expiresAt,
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
	}

	clearChallenge(response: Response): void {
		response.clearCookie(this.challengeCookieName, {
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
	}

	readSession(request: Request): string | undefined {
		return this.readCookie(request, this.sessionCookieName);
	}

	readCsrf(request: Request): string | undefined {
		return this.readCookie(request, this.csrfCookieName);
	}

	setSession(response: Response, token: string, expiresAt: Date): void {
		response.cookie(this.sessionCookieName, token, {
			expires: expiresAt,
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
	}

	setCsrf(response: Response, token: string, expiresAt: Date): void {
		response.cookie(this.csrfCookieName, token, {
			expires: expiresAt,
			httpOnly: false,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
	}

	clearSession(response: Response): void {
		response.clearCookie(this.sessionCookieName, {
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
		this.clearChallenge(response);
		response.clearCookie(this.csrfCookieName, {
			httpOnly: false,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
	}

	private challengeSignature(token: string): string {
		return this.tokens.digest(JSON.stringify(['platform-challenge-cookie-v1', this.origin, token]));
	}

	private readCookie(request: Request, name: string): string | undefined {
		const header = request.headers.cookie;
		if (header === undefined) {
			return undefined;
		}
		return parse(header)[name];
	}
}
