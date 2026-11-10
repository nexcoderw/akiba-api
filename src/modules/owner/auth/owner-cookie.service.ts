import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'cookie';
import type { Request, Response } from 'express';

import { openOwnerSession, sealOwnerSession } from './owner-session-cookie.js';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import {
	LOCAL_OWNER_CSRF_COOKIE,
	LOCAL_OWNER_SESSION_COOKIE,
	OWNER_CSRF_COOKIE,
	OWNER_SESSION_COOKIE,
} from './owner-auth.constants.js';

@Injectable()
export class OwnerCookieService {
	private readonly bindingKey: Buffer;
	private readonly secure: boolean;
	private readonly sessionCookieName: string;
	private readonly csrfCookieName: string;

	constructor(config: ConfigService<EnvironmentVariables, true>) {
		this.bindingKey = Buffer.from(config.get('OWNER_AUTH_TOKEN_PEPPER', { infer: true }), 'base64');
		this.secure = config.get('OWNER_AUTH_COOKIE_SECURE', { infer: true });
		this.sessionCookieName = this.secure ? OWNER_SESSION_COOKIE : LOCAL_OWNER_SESSION_COOKIE;
		this.csrfCookieName = this.secure ? OWNER_CSRF_COOKIE : LOCAL_OWNER_CSRF_COOKIE;
	}

	readSession(request: Request): string | undefined {
		return openOwnerSession(this.read(request, this.sessionCookieName), request.headers.origin, this.bindingKey);
	}

	readCsrf(request: Request): string | undefined {
		return this.read(request, this.csrfCookieName);
	}

	setSession(response: Response, token: string, expiresAt: Date, origin: string): void {
		response.cookie(this.sessionCookieName, sealOwnerSession(token, origin, this.bindingKey), {
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

	clear(response: Response): void {
		response.clearCookie(this.sessionCookieName, {
			httpOnly: true,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
		response.clearCookie(this.csrfCookieName, {
			httpOnly: false,
			path: '/',
			sameSite: 'strict',
			secure: this.secure,
		});
	}

	private read(request: Request, name: string): string | undefined {
		const header = request.headers.cookie;
		return header === undefined ? undefined : parse(header)[name];
	}
}
