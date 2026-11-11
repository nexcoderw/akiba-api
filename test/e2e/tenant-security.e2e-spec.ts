import { jest } from '@jest/globals';
import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
	OrganizationMembershipStatus,
	OrganizationStatus,
	PrismaService,
	UserStatus,
} from '@nexcoderw/akiba-db';
import request from 'supertest';

import { configureApplication } from '../../src/app-bootstrap.js';
import { AppModule } from '../../src/app.module.js';
import {
	AccessBoundary,
	RequireOrganizationPermission,
	TenantIdentityRead,
} from '../../src/common/security/route-access.decorator.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { sealOwnerSession } from '../../src/modules/owner/auth/owner-session-cookie.js';
import { OwnerAuthModule } from '../../src/modules/owner/auth/owner-auth.module.js';
import { OwnerOriginCsrfGuard } from '../../src/modules/owner/auth/owner-origin-csrf.guard.js';
import { OrganizationTenantGuard } from '../../src/modules/owner/tenant/organization-tenant.guard.js';
import { ORGANIZATION_PERMISSION } from '../../src/modules/owner/tenant/organization-permission.constants.js';
import { TenantSecurityModule } from '../../src/modules/owner/tenant/tenant-security.module.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';
import { TenantAuthorizationService } from '../../src/modules/owner/tenant/tenant-authorization.service.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const A_ORIGIN = 'https://musomesa.akiba.com';
const B_ORIGIN = 'https://companyb.akiba.com';
const TOKEN = Buffer.alloc(32, 1).toString('base64url');
const KEY = Buffer.alloc(32);
const TOKEN_B = Buffer.alloc(32, 2).toString('base64url');
const USER_B = '77777777-7777-4777-8777-777777777777';
const SESSION_B = '88888888-8888-4888-8888-888888888888';
const MEMBERSHIP_B = '66666666-6666-4666-8666-666666666666';

/** Probes exist only here: no new production mutation or permission-management endpoints. */
@Controller('security-probe')
class SecurityProbeController {
	@Get('unclassified')
	unclassified(): { secret: string } {
		return { secret: 'must-not-be-returned' };
	}
	@Get('unguarded')
	@AccessBoundary('platform')
	unguarded(): { secret: string } {
		return { secret: 'must-not-be-returned' };
	}
}

@AccessBoundary('organization')
@UseGuards(OwnerOriginCsrfGuard, OrganizationTenantGuard)
@Controller('tenant-mutation-probe')
class TenantMutationProbeController {
	@Get('permission-read')
	@RequireOrganizationPermission(ORGANIZATION_PERMISSION.membersRead)
	permissionRead(): { authorized: boolean } {
		return { authorized: true };
	}
	@Get('conflicting-read')
	@TenantIdentityRead()
	@RequireOrganizationPermission(ORGANIZATION_PERMISSION.membersRead)
	conflictingRead(): never {
		throw new Error('Conflicting tenant metadata was accepted.');
	}
	@Get('future-read')
	futureRead(): never {
		throw new Error('Read permission guard did not run.');
	}
	@Patch(':id')
	update(): never {
		throw new Error('Mutation guard did not run.');
	}
	@Delete(':id')
	remove(): never {
		throw new Error('Mutation guard did not run.');
	}
	@Post('bulk')
	bulk(): never {
		throw new Error('Mutation guard did not run.');
	}
}

describe('tenant security boundary (offline adapters, real guards and services)', () => {
	let app: NestExpressApplication;
	let tokens: OwnerTokenService;
	let tenant: TenantAuthorizationService;
	let organizations: { id: string; name: string; slug: string; status: OrganizationStatus }[];
	let membershipStatus: OrganizationMembershipStatus;
	let revoked: boolean;
	let accountStatus: UserStatus;
	let credentialDisabled: boolean;
	let multiple: boolean;
	let removedAfterAuthentication: boolean;
	let systemOwner: boolean;
	let failNextRead: boolean;
	let inactiveMemberships: Set<string>;
	const observedScopes: string[] = [];
	const memberReads = jest.fn<(where: unknown) => void>();

	function sessionRow(token = TOKEN) {
		const second = token === TOKEN_B;
		const organization = organizations.find((item) => item.id === (second ? B : A));
		if (organization === undefined) throw new Error('Synthetic organization is missing.');
		return {
			id: second ? SESSION_B : SESSION,
			organizationId: organization.id,
			membershipId: second ? MEMBERSHIP_B : MEMBERSHIP,
			enrollmentChallengeId: null,
			enrollmentChallenge: null,
			membership:
				membershipStatus === OrganizationMembershipStatus.ACTIVE &&
				!inactiveMemberships.has(organization.id)
					? {
							id: second ? MEMBERSHIP_B : MEMBERSHIP,
							status: membershipStatus,
							organization,
							roles: [{ organizationRole: { key: 'owner' } }],
						}
					: null,
			assurance: 'AAL1',
			authenticatedAt: new Date('2026-01-01'),
			idleExpiresAt: new Date('2099-01-01'),
			absoluteExpiresAt: new Date('2099-01-01'),
			revokedAt: revoked ? new Date('2026-01-02') : null,
			user: {
				id: second ? USER_B : USER,
				displayName: 'Fictional Owner',
				email: 'owner@example.com',
				status: accountStatus,
				emailVerifiedAt: new Date('2025-01-01'),
				passwordCredential: {
					passwordChangedAt: new Date('2025-01-01'),
					disabledAt: credentialDisabled ? new Date('2026-01-01') : null,
				},
			},
		};
	}

	/** Every fake transaction has distinct local settings; physical pool guarantees are DB integration tests. */
	async function transaction(operation: (client: unknown) => Promise<unknown>): Promise<unknown> {
		let scope: unknown;
		const client = {
			$queryRaw: (sql: TemplateStringsArray, value: unknown): Promise<unknown[]> => {
				if (sql.join('').includes('app.current_organization_id')) scope = value;
				return Promise.resolve([]);
			},
			platformAdminSession: {
				findUnique: () => Promise.resolve(null),
				updateMany: () => Promise.resolve({ count: 0 }),
			},
			ownerSession: {
				findUnique: (args: { where: { tokenDigest: string } }) =>
					Promise.resolve(
						args.where.tokenDigest === tokens.sessionDigest(TOKEN)
							? sessionRow()
							: args.where.tokenDigest === tokens.sessionDigest(TOKEN_B)
								? sessionRow(TOKEN_B)
								: null,
					),
				findFirst: (args: {
					where: { id: string; organizationId?: string; membershipId?: string };
				}) => {
					const row = sessionRow(args.where.id === SESSION_B ? TOKEN_B : TOKEN);
					return Promise.resolve(
						revoked ||
							args.where.organizationId !== row.organizationId ||
							args.where.membershipId !== row.membershipId
							? null
							: row,
					);
				},
				updateMany: () => Promise.resolve({ count: 1 }),
			},
			organizationMembership: {
				findFirst: async (args: {
					where: {
						id: string;
						userId: string;
						organizationId: string;
						status: OrganizationMembershipStatus;
						organization: { slug: string; status: OrganizationStatus };
					};
				}) => {
					memberReads(args.where);
					await Promise.resolve();
					if (failNextRead) {
						failNextRead = false;
						throw new Error('private-sql secret-connection');
					}
					const org = organizations.find(
						(item) =>
							item.id === args.where.organizationId &&
							item.slug === args.where.organization.slug &&
							item.status === args.where.organization.status,
					);
					if (scope !== args.where.organizationId) throw new Error('Missing transaction scope.');
					if (typeof scope === 'string') observedScopes.push(scope);
					const expectedMembership = args.where.organizationId === A ? MEMBERSHIP : MEMBERSHIP_B;
					const allowedUser =
						(args.where.userId === USER && (args.where.organizationId === A || multiple)) ||
						(args.where.userId === USER_B && args.where.organizationId === B);
					if (
						org === undefined ||
						!allowedUser ||
						args.where.id !== expectedMembership ||
						args.where.status !== membershipStatus ||
						removedAfterAuthentication
					)
						return null;
					return {
						id: expectedMembership,
						organization: org,
						roles: systemOwner
							? [
									{
										organizationRole: {
											key: 'owner',
											isSystem: true,
											isActive: true,
											permissions: [],
										},
									},
								]
							: [],
					};
				},
			},
		};
		return operation(client);
	}

	beforeAll(async () => {
		const config = new ConfigService({
			...validateEnvironment({ NODE_ENV: 'test' }),
			API_PUBLIC_ORIGIN: 'https://api.akiba.com',
			CORS_ORIGINS: [A_ORIGIN, B_ORIGIN, 'http://localhost:4000'],
			ORGANIZATION_PORTAL_ORIGIN: null,
			ORGANIZATION_PORTAL_BASE_DOMAIN: 'akiba.com',
			RATE_LIMIT_LIMIT: 10000,
		});
		const module = await Test.createTestingModule({
			imports: [AppModule, OwnerAuthModule, TenantSecurityModule],
			controllers: [SecurityProbeController, TenantMutationProbeController],
		})
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(ConfigService)
			.useValue(config)
			.overrideProvider(PrismaService)
			.useValue({ $transaction: transaction })
			.compile();
		tokens = module.get(OwnerTokenService);
		tenant = module.get(TenantAuthorizationService);
		app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
		configureApplication(app, { CORS_ORIGINS: [A_ORIGIN, B_ORIGIN], SWAGGER_ENABLED: false });
		await app.init();
	});
	afterAll(async () => {
		await app.close();
	});
	beforeEach(() => {
		organizations = [
			{ id: A, name: 'Musomesa', slug: 'musomesa', status: OrganizationStatus.ACTIVE },
			{ id: B, name: 'Company B', slug: 'companyb', status: OrganizationStatus.ACTIVE },
		];
		membershipStatus = OrganizationMembershipStatus.ACTIVE;
		revoked = false;
		accountStatus = UserStatus.ACTIVE;
		credentialDisabled = false;
		multiple = false;
		removedAfterAuthentication = false;
		systemOwner = true;
		failNextRead = false;
		inactiveMemberships = new Set();
		observedScopes.length = 0;
		memberReads.mockClear();
		app.set('trust proxy', false);
	});

	function call(id = A, origin = A_ORIGIN, cookieOrigin = origin, token = TOKEN): request.Test {
		return request(app.getHttpServer())
			.get(`/api/v1/owner/organizations/${id}/dashboard`)
			.set('Host', 'api.akiba.com')
			.set('Origin', origin)
			.set('Cookie', `akiba-owner-session=${sealOwnerSession(token, cookieOrigin, KEY)}`);
	}

	it('returns only the authenticated organization with explicit scoped persistence', async () => {
		const response = await call().expect(200);
		expect(response.body).toMatchObject({ organizationId: A, organizationName: 'Musomesa' });
		expect(memberReads).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: A, userId: USER, id: MEMBERSHIP }),
		);
		expect(observedScopes).toEqual([A]);
	});
	it.each([UserStatus.SUSPENDED, UserStatus.DISABLED])(
		'denies global account status %s despite active membership',
		async (status) => {
			accountStatus = status;
			await call().expect(401);
		},
	);
	it('denies a disabled global password credential despite active membership', async () => {
		credentialDisabled = true;
		await call().expect(401);
	});
	it('denies missing credentials and platform cookies at organization routes', async () => {
		await call().unset('Cookie').expect(401);
		await call().set('Cookie', 'akiba-platform-session=platform-only-token').expect(401);
	});
	it('denies another organization identifier without exposing its existence', async () => {
		const response = await call(B).expect(404);
		expect(response.body).toMatchObject({
			code: 'RESOURCE_NOT_FOUND',
			status: 404,
			requestId: response.get('X-Request-Id'),
		});
		expect(JSON.stringify(response.body)).not.toContain('Company B');
		expect(memberReads).not.toHaveBeenCalled();
	});
	it('separates users with different organization memberships', async () => {
		await call(B, B_ORIGIN, B_ORIGIN, TOKEN_B).expect(200);
		await call(A, A_ORIGIN, A_ORIGIN, TOKEN_B).expect(404);
		await call(B, B_ORIGIN).expect(404);
	});
	it('does not reuse an organization-bound session at a sibling portal even with both memberships', async () => {
		multiple = true;
		await call(B, B_ORIGIN, A_ORIGIN).expect(401);
		await call(B, B_ORIGIN).expect(404);
	});
	it('checks the selected membership rather than another active membership', async () => {
		multiple = true;
		inactiveMemberships.add(B);
		await call().expect(200);
		await call(B, B_ORIGIN).expect(404);
	});
	it('does not distinguish a cross-tenant identifier from an absent resource', async () => {
		const denied = await call(B).expect(404);
		const absent = await call('99999999-9999-4999-8999-999999999999').expect(404);
		expect(denied.get('Content-Type')).toContain('application/problem+json');
		const deniedBody: unknown = denied.body;
		const absentBody: unknown = absent.body;
		if (
			typeof deniedBody !== 'object' ||
			deniedBody === null ||
			!('detail' in deniedBody) ||
			typeof absentBody !== 'object' ||
			absentBody === null ||
			!('detail' in absentBody)
		)
			throw new Error('Missing problem.');
		expect(deniedBody.detail).toBe(absentBody.detail);
	});
	it.each([
		OrganizationMembershipStatus.SUSPENDED,
		OrganizationMembershipStatus.REVOKED,
		OrganizationMembershipStatus.PENDING,
	])('denies inactive membership %s', async (status) => {
		membershipStatus = status;
		await call().expect(404);
	});
	it.each([OrganizationStatus.PENDING, OrganizationStatus.SUSPENDED, OrganizationStatus.ARCHIVED])(
		'denies nonoperating organization %s',
		async (status) => {
			organizations[0] = { id: A, name: 'Musomesa', slug: 'musomesa', status };
			await call().expect(404);
		},
	);
	it('rechecks revocation and membership inside the data operation', async () => {
		removedAfterAuthentication = true;
		await call().expect(404);
		removedAfterAuthentication = false;
		revoked = true;
		await call().expect(401);
	});
	it('does not grant identity access to a non-system owner role', async () => {
		systemOwner = false;
		await call().expect(404);
	});
	it('ignores injected tenant headers, body fields and query selections', async () => {
		const response = await call()
			.set('X-Tenant-ID', B)
			.set('X-Organization-ID', B)
			.query({ organizationId: B })
			.send({ organizationId: B, platformRole: 'platform.owner' })
			.expect(200);
		expect(response.body).toMatchObject({ organizationId: A });
	});
	it.each([
		'companyb.akiba.com',
		'attacker.example',
		'admin.akiba.com',
		'api.akiba.com.attacker.example',
	])('rejects manipulated Host %s', async (host) => {
		await call().set('Host', host).expect(404);
	});
	it('ignores untrusted forwarding and validates forwarding from a reviewed proxy', async () => {
		await call().set('X-Forwarded-Host', 'companyb.akiba.com').expect(200);
		app.set('trust proxy', ['127.0.0.1/32', '::1/128', '::ffff:127.0.0.1/128']);
		await call().set('Host', 'internal').set('X-Forwarded-Host', 'musomesa.akiba.com').expect(200);
		await call()
			.set('Host', 'internal')
			.set('X-Forwarded-Host', 'musomesa.akiba.com, companyb.akiba.com')
			.expect(404);
	});
	it.each([
		'https://admin.akiba.com',
		'https://musomesa.akiba.com.attacker.example',
		'https://unknown.akiba.com',
	])('rejects unapproved or reserved portal origins %s', async (origin) => {
		await call(A, origin).expect(404);
	});
	it('keeps parallel organization requests separate after a failed operation', async () => {
		failNextRead = true;
		const failure = await call().expect(500);
		expect(JSON.stringify(failure.body)).not.toMatch(/private-sql|secret-connection/u);
		multiple = true;
		const responses = await Promise.all([
			call().expect(200),
			call(B, B_ORIGIN, B_ORIGIN, TOKEN_B).expect(200),
		]);
		expect(responses.map((response) => response.body as unknown)).toEqual([
			expect.objectContaining({ organizationId: A }),
			expect.objectContaining({ organizationId: B }),
		]);
	});
	it('does not promote an organization owner to platform administration', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/platform/dashboard/summary')
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', `akiba-owner-session=${sealOwnerSession(TOKEN, A_ORIGIN, KEY)}`)
			.expect(401);
	});
	it('cannot promote an owner credential by renaming its cookie to a platform cookie', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/platform/dashboard/summary')
			.set('Origin', 'http://localhost:4000')
			.set('Cookie', `akiba-platform-session=${sealOwnerSession(TOKEN, A_ORIGIN, KEY)}`)
			.expect(401);
	});
	it.each(['unclassified', 'unguarded'])(
		'denies a route missing its declared protections: %s',
		async (path) => {
			await request(app.getHttpServer()).get(`/api/v1/security-probe/${path}`).expect(403);
		},
	);
	it('checks a declared organization permission against the live selected membership', async () => {
		const authorized = () =>
			request(app.getHttpServer())
				.get('/api/v1/tenant-mutation-probe/permission-read')
				.set('Host', 'api.akiba.com')
				.set('Origin', A_ORIGIN)
				.set('Cookie', `akiba-owner-session=${sealOwnerSession(TOKEN, A_ORIGIN, KEY)}`);
		await authorized().expect(200, { authorized: true });
		systemOwner = false;
		await authorized().expect(403);
		expect(memberReads).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: A,
				id: MEMBERSHIP,
				userId: USER,
			}),
		);
	});
	it('denies conflicting tenant identity and permission declarations', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/tenant-mutation-probe/conflicting-read')
			.set('Host', 'api.akiba.com')
			.set('Origin', A_ORIGIN)
			.set('Cookie', `akiba-owner-session=${sealOwnerSession(TOKEN, A_ORIGIN, KEY)}`)
			.expect(403);
	});
	it.each(['patch', 'delete', 'post', 'get'] as const)(
		'fails closed for future tenant %s operations',
		async (method) => {
			const path = method === 'post' ? 'bulk' : method === 'get' ? 'future-read' : B;
			const response = await request(app.getHttpServer())
				[method](`/api/v1/tenant-mutation-probe/${path}`)
				.set('Host', 'api.akiba.com')
				.set('Origin', A_ORIGIN)
				.set('Cookie', `akiba-owner-session=${sealOwnerSession(TOKEN, A_ORIGIN, KEY)}`)
				.send({ organizationId: B, nested: { organizationId: B }, role: 'platform.owner' })
				.expect(403);
			expect(response.body).toMatchObject({ code: 'ORGANIZATION_ACCESS_DENIED' });
			expect(memberReads).not.toHaveBeenCalled();
		},
	);
	it('rejects forged or copied contexts and fails closed for future permissioned operations', async () => {
		const establish = jest.spyOn(tenant, 'establish');
		try {
			await call().expect(200);
			const result = establish.mock.results[0];
			if (result?.type !== 'return') throw new Error('No trusted context was established.');
			const context = await result.value;
			expect(Object.isFrozen(context)).toBe(true);
			expect(Object.isFrozen(context.resourceScope)).toBe(true);
			expect(() => {
				tenant.assert({ ...context, organizationId: B });
			}).toThrow();
			expect(() => {
				tenant.assert({ ...context });
			}).toThrow();
			expect(() => tenant.requirePermissions(context)).toThrow();
			expect(tenant.resourceWhere(context, B)).toEqual({ organizationId: A, id: B });
			expect(tenant.resourceWhereMany(context, [A, B])).toEqual({
				organizationId: A,
				id: { in: [A, B] },
			});
		} finally {
			establish.mockRestore();
		}
	});
});
