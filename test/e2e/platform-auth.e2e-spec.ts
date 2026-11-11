import { jest } from '@jest/globals';
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { PrismaService } from '@nexcoderw/akiba-db';
import request from 'supertest';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { AccessBoundary } from '../../src/common/security/route-access.decorator.js';
import { PlatformOriginCsrfGuard } from '../../src/modules/platform/auth/platform-origin-csrf.guard.js';
import { PlatformAuthModule } from '../../src/modules/platform/auth/platform-auth.module.js';
import { AppModule } from '../../src/app.module.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformLoginService } from '../../src/modules/platform/auth/platform-login.service.js';
import {
	PlatformMfaRejectedException,
	PlatformMfaService,
} from '../../src/modules/platform/auth/platform-mfa.service.js';
import { PlatformEmailOtpService } from '../../src/modules/platform/auth/platform-email-otp.service.js';
import { PlatformPermissionGuard } from '../../src/modules/platform/auth/platform-permission.guard.js';
import { RequirePlatformPermissions } from '../../src/modules/platform/auth/platform-permissions.decorator.js';
import { PlatformSessionGuard } from '../../src/modules/platform/auth/platform-session.guard.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';

const ADMIN_ORIGIN = 'http://localhost:4000';
const CSRF_TOKEN = 'fictional-csrf-token-with-more-than-32-characters';
const SESSION_TOKEN = 'fictional-session-token-with-more-than-32-characters';
const CHALLENGE_TOKEN = 'fictional-challenge-token-with-more-than-32-characters';

@AccessBoundary('platform')
@Controller('platform/permission-probe')
class PlatformPermissionProbeController {
	@Get()
	@UseGuards(PlatformOriginCsrfGuard, PlatformSessionGuard, PlatformPermissionGuard)
	@RequirePlatformPermissions('platform.dashboard.read')
	read(): { readonly status: 'permitted' } {
		return { status: 'permitted' };
	}
}

describe('platform authentication HTTP API (e2e)', () => {
	let application: NestExpressApplication | undefined;
	let pendingCookies: string;
	let throttleStorage: ThrottlerStorageService;
	const login = jest.fn<PlatformLoginService['login']>();
	const verifyMfa = jest.fn<PlatformMfaService['verify']>();
	const authenticate = jest.fn<PlatformSessionService['authenticate']>();
	const revoke = jest.fn<PlatformSessionService['revoke']>();
	const sendEmailOtp = jest.fn<PlatformEmailOtpService['send']>();
	const revokeChallenge = jest.fn<PlatformMfaService['revokeChallenge']>();

	beforeAll(async () => {
		login.mockResolvedValue({
			status: 'MFA_REQUIRED',
			nextStep: 'VERIFY_MFA',
			challengeToken: CHALLENGE_TOKEN,
			csrfToken: CSRF_TOKEN,
			expiresAt: '2030-01-01T00:05:00.000Z',
			methods: ['totp'],
		});
		verifyMfa.mockResolvedValue({
			status: 'authenticated',
			expiresAt: '2030-01-01T08:00:00.000Z',
			expiresAtDate: new Date('2030-01-01T08:00:00.000Z'),
			sessionToken: SESSION_TOKEN,
		});
		authenticate.mockResolvedValue({
			sessionId: '62d5bd74-9018-4d15-a353-2cb2a72c1887',
			userId: '2f5298af-cf42-4e66-8968-a42be74cb34b',
			platformStaffId: 'a652ac64-47b5-499e-a849-dca02166c46b',
			displayName: 'Akiba Administrator',
			email: 'admin@example.com',
			expiresAt: new Date('2030-01-01T08:00:00.000Z'),
			roles: ['platform.operator'],
			permissions: ['platform.dashboard.read'],
		});
		revoke.mockResolvedValue(undefined);
		revokeChallenge.mockResolvedValue(undefined);
		sendEmailOtp.mockResolvedValue({
			status: 'sent',
			expiresAt: '2030-01-01T00:05:00.000Z',
			retryAfterSeconds: 60,
		});

		const module = await Test.createTestingModule({
			imports: [AppModule, PlatformAuthModule],
			controllers: [PlatformPermissionProbeController],
		})
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue({})
			.overrideProvider(PlatformLoginService)
			.useValue({ login })
			.overrideProvider(PlatformMfaService)
			.useValue({ verify: verifyMfa, revokeChallenge })
			.overrideProvider(PlatformSessionService)
			.useValue({ authenticate, revoke })
			.overrideProvider(PlatformEmailOtpService)
			.useValue({ send: sendEmailOtp })
			.compile();
		application = module.createNestApplication<NestExpressApplication>();
		configureApplication(application, validateEnvironment({ NODE_ENV: 'test' }));
		await application.init();
		const storage = module.get<ThrottlerStorage>(ThrottlerStorage);
		if (!(storage instanceof ThrottlerStorageService)) throw new Error('Expected real throttling.');
		throttleStorage = storage;
		const pending = await request(application.getHttpServer())
			.post('/api/v1/platform/auth/login')
			.set('Origin', ADMIN_ORIGIN)
			.send({ email: 'admin@example.com', password: 'fictional password' })
			.expect(200);
		const challengeCookie = (pending.get('Set-Cookie') ?? [])
			.find((cookie) => cookie.startsWith('akiba-platform-challenge='))
			?.split(';')[0];
		if (challengeCookie === undefined) throw new Error('Expected a pending challenge cookie.');
		pendingCookies = `${challengeCookie}; akiba-platform-csrf=${CSRF_TOKEN}`;
	});

	beforeEach(() => {
		// Keep the real guard and counters; each independent HTTP scenario gets its own window.
		throttleStorage.onApplicationShutdown();
	});

	afterAll(async () => {
		await application?.close();
	});

	it('sends an email code with Origin and CSRF proof without issuing cookies', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/email')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', pendingCookies)
			.set('X-Platform-CSRF-Token', CSRF_TOKEN)
			.send({})
			.expect(200);
		expect(response.headers['set-cookie']).toBeUndefined();
		const body: unknown = response.body;
		expect(body).toEqual({
			status: 'sent',
			expiresAt: '2030-01-01T00:05:00.000Z',
			retryAfterSeconds: 60,
		});
	});

	it.each([{ Origin: 'http://localhost:4000' }, { Origin: 'https://foreign.example' }])(
		'rejects email delivery without trusted Origin and CSRF: %p',
		async (headers) => {
			const before = sendEmailOtp.mock.calls.length;
			await request(requireApplication(application).getHttpServer())
				.post('/api/v1/platform/auth/mfa/email')
				.set(headers)
				.send({ challengeToken: 'fictional-challenge-token-with-more-than-32-characters' })
				.expect(403);
			expect(sendEmailOtp).toHaveBeenCalledTimes(before);
		},
	);

	it('creates an MFA challenge without a session cookie', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/login')
			.set('Origin', ADMIN_ORIGIN)
			.send({ email: ' ADMIN@EXAMPLE.COM ', password: 'fictional password' })
			.expect(200);
		const body: unknown = response.body;
		expect(body).toMatchObject({ status: 'MFA_REQUIRED', nextStep: 'VERIFY_MFA' });
		expect(isRecord(body) && body.challengeToken).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain(CHALLENGE_TOKEN);
		const cookies = response.get('Set-Cookie') ?? [];
		expect(cookies.some((cookie) => cookie.startsWith('akiba-platform-csrf='))).toBe(true);
		expect(cookies.some((cookie) => cookie.startsWith('akiba-platform-session='))).toBe(false);
		const pendingCookie = cookies.find((cookie) => cookie.startsWith('akiba-platform-challenge='));
		expect(pendingCookie).toContain('HttpOnly');
		expect(pendingCookie).toContain('SameSite=Strict');
		expect(pendingCookie).not.toContain('Domain=');
		const loginCall = login.mock.calls[0];
		if (loginCall === undefined) {
			throw new Error('Expected the login service to be called.');
		}
		expect(loginCall[0]).toEqual({
			email: 'admin@example.com',
			password: 'fictional password',
		});
		expect(typeof loginCall[1]).toBe('string');
	});

	it('rejects login from an unapproved Origin', async () => {
		await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/login')
			.set('Origin', 'https://attacker.example')
			.send({ email: 'admin@example.com', password: 'fictional password' })
			.expect(403);
	});

	it('rejects invalid login DTOs without exposing credentials', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/login')
			.set('Origin', ADMIN_ORIGIN)
			.send({ email: 'invalid', password: '' })
			.expect(400);
		const body: unknown = response.body;
		expect(JSON.stringify(body)).not.toContain('fictional password');
	});

	it('requires CSRF validation before issuing a session', async () => {
		await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/verify')
			.set('Origin', ADMIN_ORIGIN)
			.send({
				method: 'totp',
				totpCode: '123456',
			})
			.expect(403);
	});

	it('issues a host-only HttpOnly session cookie after MFA', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/verify')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', pendingCookies)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send({
				method: 'totp',
				totpCode: '123456',
			})
			.expect(200);
		const cookies = response.get('Set-Cookie') ?? [];
		const sessionCookie = cookies.find((cookie) => cookie.startsWith('akiba-platform-session='));
		expect(sessionCookie).toContain('HttpOnly');
		expect(sessionCookie).toContain('SameSite=Strict');
		expect(sessionCookie).toContain('Path=/');
		expect(sessionCookie).not.toContain('Domain=');
		expect(cookies.join(';')).toContain('akiba-platform-challenge=;');
		expect(JSON.stringify(response.body)).not.toContain(SESSION_TOKEN);
		expect(verifyMfa).toHaveBeenCalledWith(
			{ challengeToken: CHALLENGE_TOKEN, method: 'totp', totpCode: '123456' },
			undefined,
			expect.stringMatching(/^req_[0-9a-f-]{36}$/u),
		);
	});

	it('returns current server-resolved roles and permissions', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.get('/api/v1/platform/auth/me')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`)
			.expect(200);
		const body: unknown = response.body;
		expect(isRecord(body) && body.email).toBe('admin@example.com');
		expect(isRecord(body) && body.permissions).toEqual(['platform.dashboard.read']);
		expect(body).toMatchObject({ authenticated: true, mfaVerified: true });
	});

	it('does not accept a pending challenge as a session for me', async () => {
		await request(requireApplication(application).getHttpServer())
			.get('/api/v1/platform/auth/me')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', pendingCookies)
			.expect(401);
	});

	it('rejects an injected JSON challenge even with valid cookies', async () => {
		const before = verifyMfa.mock.calls.length;
		await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/verify')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', pendingCookies)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send({ challengeToken: CHALLENGE_TOKEN, method: 'totp', totpCode: '123456' })
			.expect(400);
		expect(verifyMfa).toHaveBeenCalledTimes(before);
	});

	it('rejects a recipient or bearer challenge in an email-delivery body', async () => {
		const before = sendEmailOtp.mock.calls.length;
		await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/email')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', pendingCookies)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send({ challengeToken: CHALLENGE_TOKEN, recipient: 'attacker@example.com' })
			.expect(400);
		expect(sendEmailOtp).toHaveBeenCalledTimes(before);
	});

	it('rejects a missing or tampered pending cookie before MFA verification', async () => {
		const before = verifyMfa.mock.calls.length;
		for (const cookie of [
			`akiba-platform-csrf=${CSRF_TOKEN}`,
			`akiba-platform-challenge=v1.${CHALLENGE_TOKEN}.forged; akiba-platform-csrf=${CSRF_TOKEN}`,
		]) {
			await request(requireApplication(application).getHttpServer())
				.post('/api/v1/platform/auth/mfa/verify')
				.set('Origin', ADMIN_ORIGIN)
				.set('Cookie', cookie)
				.set('x-platform-csrf-token', CSRF_TOKEN)
				.send({ method: 'totp', totpCode: '123456' })
				.expect(401);
		}
		expect(verifyMfa).toHaveBeenCalledTimes(before);
	});

	it('clears an invalidated pending cookie and returns safe Problem Details', async () => {
		verifyMfa.mockRejectedValueOnce(new PlatformMfaRejectedException(true));
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/verify')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', pendingCookies)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send({ method: 'totp', totpCode: '123456' })
			.expect(401);
		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.body).toMatchObject({ code: 'AUTH_MFA_INVALID' });
		expect((response.get('Set-Cookie') ?? []).join(';')).toContain('akiba-platform-challenge=;');
	});

	it('rejects forged platform authorities and ignores untrusted forwarding headers', async () => {
		const before = login.mock.calls.length;
		await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/login')
			.set('Origin', ADMIN_ORIGIN)
			.set('Host', 'organization.attacker.example')
			.set('X-Forwarded-Host', 'localhost:3000')
			.send({ email: 'admin@example.com', password: 'fictional password' })
			.expect(403);
		expect(login).toHaveBeenCalledTimes(before);
	});

	it('enforces endpoint throttling despite forged client-address headers', async () => {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await request(requireApplication(application).getHttpServer())
				.post('/api/v1/platform/auth/login')
				.set('Origin', ADMIN_ORIGIN)
				.set('X-Forwarded-For', `192.0.2.${attempt + 1}`)
				.send({ email: 'admin@example.com', password: 'fictional password' })
				.expect(200);
		}
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/login')
			.set('Origin', ADMIN_ORIGIN)
			.set('X-Forwarded-For', '198.51.100.12')
			.send({ email: 'admin@example.com', password: 'fictional password' })
			.expect(429);
		expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
	});

	it('rejects a missing session cookie', async () => {
		await request(requireApplication(application).getHttpServer())
			.get('/api/v1/platform/auth/session')
			.set('Origin', ADMIN_ORIGIN)
			.expect(401);
	});

	it('permits an authenticated session with the explicit permission', async () => {
		await request(requireApplication(application).getHttpServer())
			.get('/api/v1/platform/permission-probe')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`)
			.expect(200, { status: 'permitted' });
	});

	it.each([undefined, 'https://foreign.example'])(
		'rejects the permission probe without a trusted Origin: %s',
		async (origin) => {
			const before = authenticate.mock.calls.length;
			const probe = request(requireApplication(application).getHttpServer())
				.get('/api/v1/platform/permission-probe')
				.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`);
			if (origin !== undefined) probe.set('Origin', origin);
			await probe.expect(403);
			expect(authenticate).toHaveBeenCalledTimes(before);
		},
	);

	it('does not grant permission solely from an administrator role name', async () => {
		authenticate.mockResolvedValueOnce({
			sessionId: '62d5bd74-9018-4d15-a353-2cb2a72c1887',
			userId: '2f5298af-cf42-4e66-8968-a42be74cb34b',
			platformStaffId: 'a652ac64-47b5-499e-a849-dca02166c46b',
			displayName: 'Akiba Administrator',
			email: 'admin@example.com',
			expiresAt: new Date('2030-01-01T08:00:00.000Z'),
			roles: ['platform.administrator'],
			permissions: [],
		});

		await request(requireApplication(application).getHttpServer())
			.get('/api/v1/platform/permission-probe')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`)
			.expect(403);
	});

	it('revokes only the presented session and clears its cookie', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/logout')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}; ${pendingCookies}`)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.expect(204);
		expect(revoke).toHaveBeenCalledWith(SESSION_TOKEN, undefined, expect.any(String));
		expect(revokeChallenge).toHaveBeenCalledWith(CHALLENGE_TOKEN, undefined, expect.any(String));
		expect((response.get('Set-Cookie') ?? []).join(';')).toContain('akiba-platform-session=;');
		expect((response.get('Set-Cookie') ?? []).join(';')).toContain('akiba-platform-challenge=;');
		expect((response.get('Set-Cookie') ?? []).join(';')).toContain('akiba-platform-csrf=;');
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireApplication(
	application: NestExpressApplication | undefined,
): NestExpressApplication {
	if (application === undefined) {
		throw new Error('The e2e application was not initialized.');
	}
	return application;
}
