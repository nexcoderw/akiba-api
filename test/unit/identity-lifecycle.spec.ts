import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService, UserStatus } from '@nexcoderw/akiba-db';
import { argon2id, hash as argonHash } from 'argon2';

import { validateEnvironment } from '../../src/config/environment.validation.js';
import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { UserIdentityService } from '../../src/modules/identity/user-identity.service.js';
import { PasswordCredentialService } from '../../src/modules/identity/password-credential.service.js';
import type { IdentityOperationContext } from '../../src/modules/identity/identity-security.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { createIdentityDatabaseFixture } from '../fixtures/identity-database.fixture.js';
import { PlatformServiceAuthModule } from '../fixtures/platform-service-auth.module.js';

describe('internal global identity and credential lifecycle (offline adapters)', () => {
	let module: TestingModule;
	let database: ReturnType<typeof createIdentityDatabaseFixture>;
	let identities: UserIdentityService;
	let credentials: PasswordCredentialService;
	let passwords: PlatformPasswordService;
	let context: IdentityOperationContext;
	const secret = 'Karongi lanterns beside the quiet river';

	beforeEach(async () => {
		database = createIdentityDatabaseFixture();
		module = await Test.createTestingModule({
			imports: [PlatformServiceAuthModule],
			providers: [
				UserIdentityService,
				PasswordCredentialService,
				PlatformPasswordService,
				{ provide: PrismaService, useValue: database.prisma },
				{
					provide: ConfigService,
					useValue: new ConfigService<EnvironmentVariables, true>(
						validateEnvironment({ NODE_ENV: 'test' }),
					),
				},
			],
		}).compile();
		identities = module.get(UserIdentityService);
		credentials = module.get(PasswordCredentialService);
		passwords = module.get(PlatformPasswordService);
		context = {
			principal: await module
				.get(PlatformSessionService)
				.authenticate('fictional-identity-admin-session-with-32-characters'),
			requestId: `req_${randomUUID()}`,
		};
	});
	afterEach(async () => {
		await module.close();
	});

	function pending(email = 'aline@example.com') {
		return identities.createPending(context, { email, displayName: 'Aline Uwase' });
	}

	it('requires issued platform authority for global identities and credential writes', async () => {
		const user = await pending();
		if (context.principal === undefined) throw new Error('Missing issued fixture identity.');
		for (const principal of [undefined, { ...context.principal, roles: ['organization.owner'] }]) {
			const denied = { ...context, principal };
			await expect(identities.profile(denied, user.id)).rejects.toMatchObject({ status: 403 });
			await expect(
				identities.createPending(denied, { email: 'other@example.com', displayName: 'Other' }),
			).rejects.toMatchObject({ status: 403 });
			await expect(
				credentials.setPassword(
					denied,
					{ userId: user.id, identityVersion: 1, credentialVersion: null },
					Buffer.from(secret),
				),
			).rejects.toMatchObject({ status: 403 });
		}
		expect(database.state.credentials.size).toBe(0);
	});

	it('creates one pending global identity under concurrent case-equivalent requests', async () => {
		const result = await Promise.allSettled([
			pending('ALINE@example.com'),
			pending('aline@EXAMPLE.com'),
		]);
		expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
		expect(database.state.users.size).toBe(1);
		expect(database.state.events.map((event) => event.action)).toEqual(['identity_created']);
		const user = [...database.state.users.values()][0];
		expect(user).toMatchObject({
			status: UserStatus.PENDING,
			emailVerifiedAt: null,
			identityVersion: 1,
		});
		expect(database.state.credentials.size).toBe(0);
	});

	it('consumes one mailbox proof atomically without granting membership or privileges', async () => {
		const user = await pending();
		const issued = await identities.issueEmailVerification(context, user.id, 1, user.email);
		const stored = [...database.state.proofs.values()][0];
		expect(stored?.tokenDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(JSON.stringify(stored)).not.toContain(issued.token);
		await identities.consumeEmailVerification(issued.token, context.requestId);
		expect(await identities.profile(context, user.id)).toMatchObject({
			status: UserStatus.ACTIVE,
			identityVersion: 2,
			emailVerifiedAt: expect.any(Date),
		});
		await expect(
			identities.consumeEmailVerification(issued.token, context.requestId),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		expect(database.state.events.map((event) => event.action)).toEqual([
			'identity_created',
			'email_verified',
		]);
		expect(database.state.credentials.size).toBe(0);
	});

	it('rejects expired and stale proofs and verifies controlled email changes', async () => {
		const user = await pending();
		const initial = await identities.issueEmailVerification(context, user.id, 1, user.email);
		const row = [...database.state.proofs.values()][0];
		if (row === undefined) throw new Error('Missing proof fixture.');
		row.expiresAt = new Date(0);
		await expect(
			identities.consumeEmailVerification(initial.token, context.requestId),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		const next = await identities.issueEmailVerification(
			context,
			user.id,
			1,
			'aline+new@example.com',
		);
		database.client.organizationOwnerEnrollmentChallenge.updateMany.mockImplementationOnce(() => {
			// Invitation integrity binds pending proofs to the old mailbox until revocation.
			expect(database.state.users.get(user.id)?.email).toBe(user.email);
			return Promise.resolve({ count: 1 });
		});
		await identities.consumeEmailVerification(next.token, context.requestId);
		expect(await identities.profile(context, user.id)).toMatchObject({
			email: 'aline+new@example.com',
			identityVersion: 2,
			status: UserStatus.ACTIVE,
		});
		const stale = await identities.issueEmailVerification(
			context,
			user.id,
			2,
			'aline+stale@example.com',
		);
		await credentials.setPassword(
			context,
			{ userId: user.id, identityVersion: 2, credentialVersion: null },
			Buffer.from(secret),
		);
		await expect(
			identities.consumeEmailVerification(stale.token, context.requestId),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
	});

	it('audits reviewed lifecycle transitions and invalidates existing authentication state', async () => {
		const user = await pending();
		await expect(
			identities.changeStatus(context, user.id, 1, UserStatus.ACTIVE),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		const proof = await identities.issueEmailVerification(context, user.id, 1, user.email);
		await identities.consumeEmailVerification(proof.token, context.requestId);
		await identities.changeStatus(context, user.id, 2, UserStatus.SUSPENDED);
		await expect(
			identities.issueEmailVerification(context, user.id, 3, user.email),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		await identities.changeStatus(context, user.id, 3, UserStatus.ACTIVE);
		await identities.changeStatus(context, user.id, 4, UserStatus.DISABLED);
		await expect(
			identities.changeStatus(context, user.id, 5, UserStatus.ACTIVE),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		expect(database.state.events.map((event) => event.action)).toEqual([
			'identity_created',
			'email_verified',
			'account_suspended',
			'account_reactivated',
			'account_disabled',
		]);
		expect(database.state.revocations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ table: 'owner', where: { userId: user.id, revokedAt: null } }),
				expect.objectContaining({
					table: 'platform',
					where: { platformStaff: { userId: user.id }, revokedAt: null },
				}),
			]),
		);
	});

	it('prevents lost replacements and records monotonic password state without leaking it', async () => {
		const user = await pending();
		await credentials.setPassword(
			context,
			{ userId: user.id, identityVersion: 1, credentialVersion: null },
			Buffer.from(secret),
		);
		const before = structuredClone(database.state.credentials.get(user.id));
		const target = { userId: user.id, identityVersion: 2, credentialVersion: 1 };
		const results = await Promise.allSettled([
			credentials.setPassword(
				context,
				target,
				Buffer.from('Rubavu notebooks beside the evening river'),
			),
			credentials.setPassword(
				context,
				target,
				Buffer.from('Rulindo lanterns beyond the mountain trail'),
			),
		]);
		expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
		const after = database.state.credentials.get(user.id);
		if (before === undefined || after === undefined) throw new Error('Missing credential fixture.');
		expect(after.version).toBe(2);
		expect(after.passwordChangedAt.getTime()).toBeGreaterThan(before.passwordChangedAt.getTime());
		expect(await passwords.verify(after.passwordHash, secret, after.normalization)).toBe(false);
		const profile = await identities.profile(context, user.id);
		expect(profile).not.toHaveProperty('passwordCredential');
		expect(JSON.stringify(profile)).not.toContain(after.passwordHash);
		expect(JSON.stringify(database.state.events)).not.toMatch(
			/passwordHash|Karongi|Rubavu|Rulindo/u,
		);
	});

	it('rolls back credentials, revocations and versions when auditing fails', async () => {
		const user = await pending();
		await credentials.setPassword(
			context,
			{ userId: user.id, identityVersion: 1, credentialVersion: null },
			Buffer.from(secret),
		);
		const before = structuredClone(database.state);
		database.state.failAudit = true;
		await expect(
			credentials.setPassword(
				context,
				{ userId: user.id, identityVersion: 2, credentialVersion: 1 },
				Buffer.from('Musanze pages beside the quiet garden'),
			),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		expect(database.state.users).toEqual(before.users);
		expect(database.state.credentials).toEqual(before.credentials);
		expect(database.state.revocations).toEqual(before.revocations);
		expect(database.state.events).toEqual(before.events);
	});

	it('disables compromised credentials with session invalidation and a secret-free audit', async () => {
		const user = await pending();
		await credentials.setPassword(
			context,
			{ userId: user.id, identityVersion: 1, credentialVersion: null },
			Buffer.from(secret),
		);
		await credentials.disable(
			context,
			{ userId: user.id, identityVersion: 2, credentialVersion: 1 },
			'compromised',
		);
		expect(database.state.credentials.get(user.id)).toMatchObject({
			version: 2,
			disabledAt: expect.any(Date),
		});
		expect(database.state.events.at(-1)).toMatchObject({
			action: 'credential_compromised',
			credentialVersion: 2,
		});
		await expect(
			credentials.upgradeHash(
				context,
				{ userId: user.id, identityVersion: 3, credentialVersion: 2 },
				Buffer.from(secret),
			),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
	});

	it('requires correct-password verification before upgrading a raw credential without revoking sessions', async () => {
		const user = await pending();
		await credentials.setPassword(
			context,
			{ userId: user.id, identityVersion: 1, credentialVersion: null },
			Buffer.from(secret),
		);
		const row = database.state.credentials.get(user.id);
		if (row === undefined) throw new Error('Missing credential fixture.');
		row.normalization = 'raw';
		row.passwordHash = await argonHash(secret, {
			type: argon2id,
			memoryCost: 19456,
			timeCost: 2,
			parallelism: 1,
		});
		const changedAt = row.passwordChangedAt;
		const revocations = database.state.revocations.length;
		const target = { userId: user.id, identityVersion: 2, credentialVersion: 1 };
		await expect(
			credentials.upgradeHash(context, target, Buffer.from('An incorrect fictional passphrase')),
		).rejects.toMatchObject({ publicCode: 'ACCOUNT_ACTION_UNAVAILABLE' });
		await expect(credentials.upgradeHash(context, target, Buffer.from(secret))).resolves.toBe(true);
		expect(database.state.credentials.get(user.id)).toMatchObject({
			version: 2,
			normalization: 'raw',
			passwordChangedAt: changedAt,
		});
		expect(database.state.revocations).toHaveLength(revocations);
		expect(database.state.events.at(-1)).toMatchObject({
			action: 'password_rehashed',
			credentialVersion: 2,
		});
	});
});
