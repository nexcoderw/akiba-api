import { jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { OrganizationStatus } from '@nexcoderw/akiba-db';
import request from 'supertest';

import { configureApplication } from '../../src/app-bootstrap.js';
import {
	OWNER_CSRF_COOKIE,
	OWNER_SESSION_COOKIE,
} from '../../src/modules/owner/auth/owner-auth.constants.js';
import { OwnerCookieService } from '../../src/modules/owner/auth/owner-cookie.service.js';
import { OwnerOriginCsrfGuard } from '../../src/modules/owner/auth/owner-origin-csrf.guard.js';
import { OwnerSessionGuard } from '../../src/modules/owner/auth/owner-session.guard.js';
import { OwnerSessionService } from '../../src/modules/owner/auth/owner-session.service.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';
import { OwnerAcceptanceService } from '../../src/modules/owner/enrollment/owner-acceptance.service.js';
import { OwnerEnrollmentController } from '../../src/modules/owner/enrollment/owner-enrollment.controller.js';
import { OwnerEnrollmentService } from '../../src/modules/owner/enrollment/owner-enrollment.service.js';
import { OwnerEnrollmentSessionGuard } from '../../src/modules/owner/enrollment/owner-enrollment-session.guard.js';
import { OwnerPortalController } from '../../src/modules/owner/portal/owner-portal.controller.js';

const SESSION_TOKEN = 'a'.repeat(43);
const CSRF_TOKEN = 'b'.repeat(43);
const CHALLENGE_TOKEN = 'c'.repeat(43);
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_ID = '22222222-2222-4222-8222-222222222222';
const SOHO_ORIGIN = 'https://kimihurura.akiba.com';

describe('owner invitation acceptance authorization (e2e)', () => {
	let application: NestExpressApplication | undefined;
	const authenticate = jest.fn<OwnerSessionService['authenticate']>();
	const accept = jest.fn<OwnerAcceptanceService['accept']>();

	beforeAll(async () => {
		const configValues = new Map<string, unknown>([
			['ORGANIZATION_PORTAL_ORIGIN', null],
			['ORGANIZATION_PORTAL_BASE_DOMAIN', 'akiba.com'],
			['OWNER_AUTH_COOKIE_SECURE', true],
		]);
		const module = await Test.createTestingModule({
			controllers: [OwnerEnrollmentController, OwnerPortalController],
			providers: [
				OwnerCookieService,
				OwnerEnrollmentSessionGuard,
				OwnerOriginCsrfGuard,
				OwnerSessionGuard,
				{
					provide: ConfigService,
					useValue: { get: (key: string): unknown => configValues.get(key) },
				},
				{
					provide: OwnerTokenService,
					useValue: {
						create: () => CSRF_TOKEN,
						equal: (left: string, right: string) => left === right,
						isValid: (token: string) => token === SESSION_TOKEN,
					},
				},
				{ provide: OwnerSessionService, useValue: { authenticate } },
				{ provide: OwnerAcceptanceService, useValue: { accept } },
				{
					provide: OwnerEnrollmentService,
					useValue: { register: jest.fn(), start: jest.fn(), verifyExisting: jest.fn() },
				},
			],
		}).compile();
		application = module.createNestApplication<NestExpressApplication>();
		configureApplication(application, {
			CORS_ORIGINS: [],
			ORGANIZATION_PORTAL_BASE_DOMAIN: 'akiba.com',
			SWAGGER_ENABLED: false,
		});
		await application.init();
	});

	beforeEach(() => {
		jest.clearAllMocks();
		authenticate.mockResolvedValue({
			sessionId: '33333333-3333-4333-8333-333333333333',
			userId: '44444444-4444-4444-8444-444444444444',
			displayName: 'Aline Uwase',
			email: 'aline@example.com',
			assurance: 'AAL1',
			expiresAt: new Date('2030-01-01T00:00:00.000Z'),
			organizations: [],
		});
		accept.mockImplementation((_principal, _token, _requestId, _now, organizationSlug) => {
			if (organizationSlug !== 'kimihurura') {
				throw new ConflictException({
					code: 'OWNER_ENROLLMENT_CONFLICT',
					message: 'This organization is not eligible for owner enrollment.',
				});
			}
			return Promise.resolve({
				status: 'accepted',
				organizationId: ORGANIZATION_ID,
				organizationName: 'Kimihurura Supplies',
				organizationSlug: 'kimihurura',
				organizationStatus: OrganizationStatus.ACTIVE,
				membershipId: MEMBERSHIP_ID,
			});
		});
	});

	afterAll(async () => application?.close());

	it('lets an authenticated invited owner without membership accept the invitation', async () => {
		await acceptanceRequest().expect(200).expect({
			status: 'accepted',
			organizationId: ORGANIZATION_ID,
			organizationName: 'Kimihurura Supplies',
			organizationSlug: 'kimihurura',
			organizationStatus: OrganizationStatus.ACTIVE,
			membershipId: MEMBERSHIP_ID,
		});
		expect(authenticate).toHaveBeenCalledWith(SESSION_TOKEN);
		expect(accept).toHaveBeenCalledWith(
			expect.objectContaining({
				organizations: [],
				userId: '44444444-4444-4444-8444-444444444444',
			}),
			CHALLENGE_TOKEN,
			undefined,
			undefined,
			'kimihurura',
		);
	});

	it('rejects an unauthenticated acceptance request', async () => {
		await acceptanceRequest().unset('Cookie').set('Cookie', csrfCookie()).expect(401);
		expect(authenticate).not.toHaveBeenCalled();
		expect(accept).not.toHaveBeenCalled();
	});

	it('rejects an invalid CSRF token before authenticating the session', async () => {
		await acceptanceRequest().set('x-owner-csrf-token', 'invalid').expect(403);
		expect(authenticate).not.toHaveBeenCalled();
		expect(accept).not.toHaveBeenCalled();
	});

	it("cannot accept Kimihurura Supplies's invitation from another organization subdomain", async () => {
		await acceptanceRequest('https://diamond-supplies.akiba.com').expect(409);
		expect(accept).toHaveBeenCalledWith(
			expect.any(Object),
			CHALLENGE_TOKEN,
			undefined,
			undefined,
			'diamond-supplies',
		);
	});

	it('keeps normal owner endpoints protected by tenant membership', async () => {
		await request(app().getHttpServer())
			.get(`/api/v1/owner/organizations/${ORGANIZATION_ID}/dashboard`)
			.set('Origin', SOHO_ORIGIN)
			.set('Cookie', sessionCookie())
			.expect(401);
	});

	function acceptanceRequest(origin = SOHO_ORIGIN): request.Test {
		return request(app().getHttpServer())
			.post('/api/v1/owner-enrollment/acceptances')
			.set('Origin', origin)
			.set('Cookie', `${sessionCookie()}; ${csrfCookie()}`)
			.set('x-owner-csrf-token', CSRF_TOKEN)
			.send({ challengeToken: CHALLENGE_TOKEN });
	}

	function app(): NestExpressApplication {
		if (application === undefined) throw new Error('Owner enrollment test app is unavailable.');
		return application;
	}

	function sessionCookie(): string {
		return `${OWNER_SESSION_COOKIE}=${SESSION_TOKEN}`;
	}

	function csrfCookie(): string {
		return `${OWNER_CSRF_COOKIE}=${CSRF_TOKEN}`;
	}
});
