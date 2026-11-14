import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { PrismaService } from '@nexcoderw/akiba-db';
import request from 'supertest';

import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/app-bootstrap.js';
import { ApiProblemException } from '../../src/common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformMfaManagementService } from '../../src/modules/platform/mfa/platform-mfa-management.service.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';

const ORIGIN = 'http://localhost:4000';
const TOKEN = Buffer.alloc(32, 1).toString('base64url');
const PROOF = Buffer.alloc(32, 2).toString('base64url');
const CSRF = 'fictional-csrf-proof-at-least-32-characters';
const FACTOR = '44444444-4444-4444-8444-444444444444';
const COOKIE = `akiba-platform-session=${TOKEN}; akiba-platform-csrf=${CSRF}`;

describe('platform MFA management HTTP security', () => {
	let app: NestExpressApplication;
	let config: ConfigService<EnvironmentVariables, true>;
	let storage: ThrottlerStorageService;
	let operationCookie: string;
	const start = jest.fn<PlatformMfaManagementService['start']>();
	const enroll = jest.fn<PlatformMfaManagementService['enroll']>();
	const confirm = jest.fn<PlatformMfaManagementService['confirm']>();
	const verify = jest.fn<PlatformMfaManagementService['verify']>();
	const list = jest.fn<PlatformMfaManagementService['list']>();
	beforeAll(async () => {
		const environment = validateEnvironment({
			NODE_ENV: 'test',
			PLATFORM_MFA_MANAGEMENT_ENABLED: 'true',
			RESEND_API_KEY: 're_fictional',
			RESEND_FROM_EMAIL: 'security@example.com',
		});
		config = new ConfigService<EnvironmentVariables, true>({ ...environment });
		start.mockResolvedValue({
			token: PROOF,
			expiresAt: new Date('2030-01-01T00:05:00.000Z'),
			verified: false,
		});
		enroll.mockResolvedValue({
			token: PROOF,
			secret: 'JBSWY3DPEHPK3PXP',
			enrollmentUri: 'otpauth://totp/Akiba:owner',
			expiresAt: new Date('2030-01-01T00:05:00.000Z'),
		});
		confirm.mockResolvedValue(['ABCD-1234-ABCD-1234-ABCD-1234-ABCD-1234']);
		verify.mockResolvedValue(undefined);
		list.mockResolvedValue([
			{
				id: FACTOR,
				type: 'totp',
				label: 'Work',
				status: 'active',
				createdAt: '2030-01-01T00:00:00.000Z',
				lastUsedAt: null,
			},
		]);
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(ConfigService)
			.useValue(config)
			.overrideProvider(PrismaService)
			.useValue({})
			.overrideProvider(PlatformSessionService)
			.useValue({
				authenticateForMfaManagement: jest
					.fn<PlatformSessionService['authenticateForMfaManagement']>()
					.mockImplementation((token) => {
						if (token !== TOKEN) throw new ApiProblemException('UNAUTHENTICATED');
						return Promise.resolve({
							sessionId: 'session-id',
							userId: 'user-id',
							platformStaffId: 'staff-id',
							email: 'owner@example.com',
							displayName: 'Owner',
							expiresAt: new Date('2030-01-01T00:05:00.000Z'),
							roles: ['platform.owner'],
							permissions: [],
							authenticationMethod: 'totp',
						});
					}),
			})
			.overrideProvider(PlatformMfaManagementService)
			.useValue({ start, enroll, confirm, verify, list })
			.compile();
		app = module.createNestApplication<NestExpressApplication>();
		configureApplication(app, environment);
		await app.init();
		const candidate = module.get<ThrottlerStorage>(ThrottlerStorage);
		if (!(candidate instanceof ThrottlerStorageService))
			throw new Error('Expected the real limiter.');
		storage = candidate;
		const response = await request(app.getHttpServer())
			.post('/api/v1/platform/auth/step-up/start')
			.set('Origin', ORIGIN)
			.set('Cookie', COOKIE)
			.set('x-platform-csrf-token', CSRF)
			.send({ operation: 'totp_replace', factorId: FACTOR, password: 'fictional current password' })
			.expect(200);
		const issued = (response.get('Set-Cookie') ?? []).find((cookie) =>
			cookie.startsWith('akiba-platform-step-up='),
		);
		if (issued === undefined) throw new Error('Expected the HttpOnly operation cookie.');
		const value = issued.split(';')[0];
		if (value === undefined) throw new Error('Expected a serialized operation cookie.');
		operationCookie = `${COOKIE}; ${value}`;
	});
	afterAll(async () => {
		await app.close();
	});
	beforeEach(() => {
		storage.onApplicationShutdown();
		config.set('PLATFORM_MFA_MANAGEMENT_ENABLED', true);
		jest.clearAllMocks();
	});

	it('keeps security management unavailable until explicitly enabled', async () => {
		config.set('PLATFORM_MFA_MANAGEMENT_ENABLED', false);
		await request(app.getHttpServer())
			.get('/api/v1/platform/auth/mfa/factors')
			.set('Origin', ORIGIN)
			.set('Cookie', COOKIE)
			.set('x-platform-csrf-token', CSRF)
			.expect(503);
		expect(list).not.toHaveBeenCalled();
	});

	it.each(['akiba-owner-session=organization-token', 'akiba-platform-challenge=pending-token'])(
		'rejects organization and pending credentials at the management boundary: %s',
		async (cookie) => {
			await request(app.getHttpServer())
				.get('/api/v1/platform/auth/mfa/factors')
				.set('Origin', ORIGIN)
				.set('Cookie', `${cookie}; akiba-platform-csrf=${CSRF}`)
				.set('x-platform-csrf-token', CSRF)
				.expect(401);
			expect(list).not.toHaveBeenCalled();
		},
	);

	it('requires both the exact admin Origin and CSRF', async () => {
		await request(app.getHttpServer())
			.post('/api/v1/platform/auth/step-up/verify')
			.set('Origin', ORIGIN)
			.set('Cookie', operationCookie)
			.send({ method: 'totp', code: '123456' })
			.expect(403);
		await request(app.getHttpServer())
			.post('/api/v1/platform/auth/step-up/verify')
			.set('Origin', 'http://localhost:4001')
			.set('Cookie', operationCookie)
			.set('x-platform-csrf-token', CSRF)
			.send({ method: 'totp', code: '123456' })
			.expect(403);
		expect(verify).not.toHaveBeenCalled();
	});

	it('rejects client identity and role injection before enrollment', async () => {
		await request(app.getHttpServer())
			.post('/api/v1/platform/auth/mfa/totp/enroll')
			.set('Origin', ORIGIN)
			.set('Cookie', operationCookie)
			.set('x-platform-csrf-token', CSRF)
			.send({ label: 'Work', userId: 'other-user', role: 'platform.owner' })
			.expect(400);
		expect(enroll).not.toHaveBeenCalled();
	});

	it('never substitutes a password or session for the operation cookie', async () => {
		const response = await request(app.getHttpServer())
			.post('/api/v1/platform/auth/mfa/totp/enroll')
			.set('Origin', ORIGIN)
			.set('Cookie', COOKIE)
			.set('x-platform-csrf-token', CSRF)
			.send({ label: 'Work' })
			.expect(403);
		expect(response.get('Content-Type')).toContain('application/problem+json');
		expect(response.get('Cache-Control')).toBe('no-store');
		expect(response.body).toMatchObject({
			code: 'AUTH_REAUTHENTICATION_REQUIRED',
			requestId: expect.stringMatching(/^req_/u),
		});
		expect(JSON.stringify(response.body)).not.toMatch(/Prisma|SELECT|stack|passwordHash/u);
		expect(enroll).not.toHaveBeenCalled();
	});

	it('rejects an operation cookie whose signature was changed', async () => {
		await request(app.getHttpServer())
			.post('/api/v1/platform/auth/mfa/totp/enroll')
			.set('Origin', ORIGIN)
			.set('Cookie', `${COOKIE}; akiba-platform-step-up=v1.${PROOF}.forged`)
			.set('x-platform-csrf-token', CSRF)
			.send({ label: 'Work' })
			.expect(403);
		expect(enroll).not.toHaveBeenCalled();
	});

	it('enforces the real step-up start quota even for an authenticated caller', async () => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await request(app.getHttpServer())
				.post('/api/v1/platform/auth/step-up/start')
				.set('Origin', ORIGIN)
				.set('Cookie', COOKIE)
				.set('x-platform-csrf-token', CSRF)
				.send({
					operation: 'totp_replace',
					factorId: FACTOR,
					password: 'fictional current password',
				})
				.expect(200);
		}
		await request(app.getHttpServer())
			.post('/api/v1/platform/auth/step-up/start')
			.set('Origin', ORIGIN)
			.set('Cookie', COOKIE)
			.set('x-platform-csrf-token', CSRF)
			.send({ operation: 'totp_replace', factorId: FACTOR, password: 'fictional current password' })
			.expect(429);
		expect(start).toHaveBeenCalledTimes(3);
	});

	it('returns setup material only in the authorized no-store response', async () => {
		const response = await request(app.getHttpServer())
			.post(`/api/v1/platform/auth/mfa/factors/${FACTOR}/replace`)
			.set('Origin', ORIGIN)
			.set('Cookie', operationCookie)
			.set('x-platform-csrf-token', CSRF)
			.send({ label: 'Work' })
			.expect(200);
		expect(response.get('Cache-Control')).toBe('no-store');
		expect(response.body).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' });
		expect(JSON.stringify(response.body)).not.toContain(PROOF);
		const cookie = (response.get('Set-Cookie') ?? []).find((value) =>
			value.startsWith('akiba-platform-step-up='),
		);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).not.toContain('Domain=');
	});

	it('returns new recovery codes after confirmation and expires authentication cookies', async () => {
		const response = await request(app.getHttpServer())
			.post(`/api/v1/platform/auth/mfa/factors/${FACTOR}/replace/confirm`)
			.set('Origin', ORIGIN)
			.set('Cookie', operationCookie)
			.set('x-platform-csrf-token', CSRF)
			.send({ code: '123456' })
			.expect(200);
		expect(response.body).toMatchObject({ status: 'reauthentication_required' });
		expect(response.get('Cache-Control')).toBe('no-store');
		expect((response.get('Set-Cookie') ?? []).join(';')).toContain('akiba-platform-session=;');
	});
});
