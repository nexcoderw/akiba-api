import { jest } from '@jest/globals';
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';
import request from 'supertest';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformCookieService } from '../../src/modules/platform/auth/platform-cookie.service.js';
import { PlatformLoginService } from '../../src/modules/platform/auth/platform-login.service.js';
import { PlatformMfaService } from '../../src/modules/platform/auth/platform-mfa.service.js';
import { PlatformEmailOtpService } from '../../src/modules/platform/auth/platform-email-otp.service.js';
import { PlatformPermissionGuard } from '../../src/modules/platform/auth/platform-permission.guard.js';
import { RequirePlatformPermissions } from '../../src/modules/platform/auth/platform-permissions.decorator.js';
import { PlatformSessionGuard } from '../../src/modules/platform/auth/platform-session.guard.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';

const ADMIN_ORIGIN = 'http://localhost:4000';
const CSRF_TOKEN = 'fictional-csrf-token-with-more-than-32-characters';
const SESSION_TOKEN = 'fictional-session-token-with-more-than-32-characters';

@Controller('platform/permission-probe')
class PlatformPermissionProbeController {
	@Get()
	@UseGuards(PlatformSessionGuard, PlatformPermissionGuard)
	@RequirePlatformPermissions('platform.dashboard.read')
	read(): { readonly status: 'permitted' } {
		return { status: 'permitted' };
	}
}

describe('platform authentication HTTP API (e2e)', () => {
	let application: NestExpressApplication | undefined;
	const login = jest.fn<PlatformLoginService['login']>();
	const verifyMfa = jest.fn<PlatformMfaService['verify']>();
	const authenticate = jest.fn<PlatformSessionService['authenticate']>();
	const revoke = jest.fn<PlatformSessionService['revoke']>();
	const sendEmailOtp = jest.fn<PlatformEmailOtpService['send']>();

	beforeAll(async () => {
		login.mockResolvedValue({
			challengeToken: 'fictional-challenge-token-with-more-than-32-characters',
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
		sendEmailOtp.mockResolvedValue({
			status: 'sent',
			expiresAt: '2030-01-01T00:05:00.000Z',
			retryAfterSeconds: 60,
		});

		const module = await Test.createTestingModule({
			imports: [AppModule],
			controllers: [PlatformPermissionProbeController],
			providers: [
				PlatformCookieService,
				PlatformPermissionGuard,
				PlatformSessionGuard,
				PlatformSessionService,
			],
		})
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue({})
			.overrideProvider(PlatformLoginService)
			.useValue({ login })
			.overrideProvider(PlatformMfaService)
			.useValue({ verify: verifyMfa })
			.overrideProvider(PlatformSessionService)
			.useValue({ authenticate, revoke })
			.overrideProvider(PlatformEmailOtpService)
			.useValue({ send: sendEmailOtp })
			.compile();
		application = module.createNestApplication<NestExpressApplication>();
		configureApplication(application, validateEnvironment({ NODE_ENV: 'test' }));
		await application.init();
	});

	afterAll(async () => {
		await application?.close();
	});

	it('sends an email code with Origin and CSRF proof without issuing cookies', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/email')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-csrf=${CSRF_TOKEN}`)
			.set('X-Platform-CSRF-Token', CSRF_TOKEN)
			.send({ challengeToken: 'fictional-challenge-token-with-more-than-32-characters' })
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
		expect(isRecord(body) && body.challengeToken).toBe(
			'fictional-challenge-token-with-more-than-32-characters',
		);
		const cookies = response.get('Set-Cookie') ?? [];
		expect(cookies.some((cookie) => cookie.startsWith('akiba-platform-csrf='))).toBe(true);
		expect(cookies.some((cookie) => cookie.startsWith('akiba-platform-session='))).toBe(false);
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
				challengeToken: 'fictional-challenge-token-with-more-than-32-characters',
				method: 'totp',
				totpCode: '123456',
			})
			.expect(403);
	});

	it('issues a host-only HttpOnly session cookie after MFA', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/mfa/verify')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-csrf=${CSRF_TOKEN}`)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.send({
				challengeToken: 'fictional-challenge-token-with-more-than-32-characters',
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
	});

	it('returns current server-resolved roles and permissions', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.get('/api/v1/platform/auth/session')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`)
			.expect(200);
		const body: unknown = response.body;
		expect(isRecord(body) && body.email).toBe('admin@example.com');
		expect(isRecord(body) && body.permissions).toEqual(['platform.dashboard.read']);
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
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`)
			.expect(200, { status: 'permitted' });
	});

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
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}`)
			.expect(403);
	});

	it('revokes only the presented session and clears its cookie', async () => {
		const response = await request(requireApplication(application).getHttpServer())
			.post('/api/v1/platform/auth/logout')
			.set('Origin', ADMIN_ORIGIN)
			.set('Cookie', `akiba-platform-session=${SESSION_TOKEN}; akiba-platform-csrf=${CSRF_TOKEN}`)
			.set('x-platform-csrf-token', CSRF_TOKEN)
			.expect(204);
		expect(revoke).toHaveBeenCalledWith(SESSION_TOKEN);
		expect((response.get('Set-Cookie') ?? []).join(';')).toContain('akiba-platform-session=;');
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
