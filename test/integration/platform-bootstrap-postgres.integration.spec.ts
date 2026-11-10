import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService, UserStatus, type Prisma } from '@nexcoderw/akiba-db';
import * as OTPAuth from 'otpauth';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { PlatformTotpService } from '../../src/modules/platform/auth/platform-totp.service.js';
import { PLATFORM_OWNER_ROLE } from '../../src/modules/platform/bootstrap/platform-bootstrap.constants.js';
import {
	acquireBootstrapLock,
	verifyBootstrapDatabase,
} from '../../src/modules/platform/bootstrap/platform-bootstrap-database.js';
import { PlatformOwnerBootstrapService } from '../../src/modules/platform/bootstrap/platform-owner-bootstrap.service.js';

// Explicit opt-in: the default suite never opens a connection or loads an operator .env file.
const postgresDescribe = process.env.BOOTSTRAP_POSTGRES_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(60_000);

postgresDescribe('first-owner bootstrap with disposable PostgreSQL', () => {
	let prisma: PrismaService;
	let observer: PrismaService;
	let environment: EnvironmentVariables;
	let config: ConfigService<EnvironmentVariables, true>;
	let service: PlatformOwnerBootstrapService;
	let verified = false;
	let lease: Promise<unknown> | undefined;
	let disconnect: (() => Promise<void>) | undefined;
	const releaseLease = deferred<undefined>();
	const fixtureEmails = new Set<string>();
	const fixtureRoleId = randomUUID();
	const fixturePermissionId = randomUUID();
	const extraPermissionId = randomUUID();
	const transactionOptions = { maxWait: 30_000, timeout: 30_000 };

	function target() {
		return {
			databaseName: requireValue(
				'PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME',
				environment.PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME,
			),
			databaseRole: 'akiba_bootstrap_test',
			databaseMarker: requireValue(
				'BOOTSTRAP_TEST_DATABASE_MARKER',
				environment.PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER,
			),
		};
	}

	function createService(configuration = config, totp = new PlatformTotpService(configuration)) {
		return new PlatformOwnerBootstrapService(
			configuration,
			prisma,
			new PlatformPasswordService(configuration),
			new PlatformTokenService(configuration),
			totp,
		);
	}

	function initialize(bootstrap = service) {
		const email = `bootstrap-${randomUUID()}@example.invalid`;
		fixtureEmails.add(email);
		return bootstrap
			.initialize({
				email,
				displayName: 'Fictional Test Owner',
				password: Buffer.from('fictional strong bootstrap password'),
			})
			.then((enrollment) => ({ email, ...enrollment }));
	}

	beforeAll(async () => {
		const databaseUrl = requireValue(
			'BOOTSTRAP_TEST_DATABASE_URL',
			process.env.BOOTSTRAP_TEST_DATABASE_URL,
		);
		const marker = requireValue(
			'BOOTSTRAP_TEST_DATABASE_MARKER',
			process.env.BOOTSTRAP_TEST_DATABASE_MARKER,
		);
		const url = new URL(databaseUrl);
		if (
			decodeURIComponent(url.username) !== 'akiba_bootstrap_test' ||
			!marker.startsWith('akiba:disposable-bootstrap-test:') ||
			/(?:prod|production|live)/iu.test(`${url.hostname}/${url.pathname}`) ||
			['postgres', 'template0', 'template1'].includes(url.pathname.slice(1))
		) {
			throw new Error('A dedicated restricted disposable bootstrap database is required.');
		}
		for (const name of [
			'DATABASE_URL',
			'DIRECT_DATABASE_URL',
			'SHADOW_DATABASE_URL',
			'TEST_DATABASE_URL',
		]) {
			const reference = process.env[name];
			if (reference !== undefined && databaseTarget(new URL(reference)) === databaseTarget(url)) {
				throw new Error(
					'The bootstrap test database must be separate from other configured databases.',
				);
			}
		}
		environment = validateEnvironment({
			NODE_ENV: 'test',
			DATABASE_URL: databaseUrl,
			PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true',
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_HOST: url.hostname,
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME: decodeURIComponent(url.pathname.slice(1)),
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE: 'akiba_bootstrap_test',
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER: marker,
		});
		config = new ConfigService<EnvironmentVariables, true>(environment);
		prisma = new PrismaService({ databaseUrl, poolMax: 4, connectionTimeoutMilliseconds: 30_000 });
		observer = new PrismaService({
			databaseUrl,
			poolMax: 1,
			connectionTimeoutMilliseconds: 30_000,
		});
		disconnect = async () => {
			await Promise.all([prisma.$disconnect(), observer.$disconnect()]);
		};
		await prisma.$connect();
		await prisma.$transaction(
			(transaction) => verifyBootstrapDatabase(transaction, target()),
			transactionOptions,
		);
		await observer.$connect();
		// A separate transaction lock excludes a second copy of this suite for its whole lifetime.
		const ready = deferred<undefined>();
		lease = prisma
			.$transaction(
				async (transaction) => {
					const rows = await transaction.$queryRaw<{ acquired: boolean }[]>`
				SELECT pg_try_advisory_xact_lock(5644759676398721836::bigint) AS acquired
			`;
					if (rows[0]?.acquired !== true)
						throw new Error('Another bootstrap test suite is running.');
					ready.resolve(undefined);
					await releaseLease.promise;
				},
				{ maxWait: 30_000, timeout: 600_000 },
			)
			.then(
				() => undefined,
				() => {
					ready.reject(
						new Error('The disposable test database lease could not be acquired or retained.'),
					);
					return 'lease-failed';
				},
			);
		await ready.promise;
		if (
			(await prisma.platformStaff.count()) !== 0 ||
			(await prisma.platformRole.findUnique({ where: { key: PLATFORM_OWNER_ROLE.key } })) !==
				null ||
			(await prisma.platformPermission.findUnique({
				where: { key: 'platform.dashboard.read' },
			})) !== null
		) {
			throw new Error(
				'The dedicated bootstrap test database must have no staff or reserved role/permission.',
			);
		}
		verified = true;
		service = createService();
	}, 60_000);

	beforeEach(async () => {
		if (!verified) throw new Error('The disposable database was not verified.');
		await prisma.$transaction(async (transaction) => {
			await acquireBootstrapLock(transaction);
			await verifyBootstrapDatabase(transaction, target());
			await transaction.platformRole.create({
				data: { id: fixtureRoleId, ...PLATFORM_OWNER_ROLE, isSystem: true },
			});
			await transaction.platformPermission.create({
				data: {
					id: fixturePermissionId,
					key: 'platform.dashboard.read',
					description: 'Fictional fixture permission',
				},
			});
		}, transactionOptions);
	});

	afterEach(async () => {
		if (!verified) return;
		await prisma.$transaction(async (transaction) => {
			await acquireBootstrapLock(transaction);
			await verifyBootstrapDatabase(transaction, target());
			const users = await transaction.user.findMany({
				where: { email: { in: [...fixtureEmails] } },
				select: { id: true },
			});
			const userIds = users.map(({ id }) => id);
			const staff = await transaction.platformStaff.findMany({
				where: { userId: { in: userIds } },
				select: { id: true },
			});
			const staffIds = staff.map(({ id }) => id);
			await transaction.platformRecoveryCode.deleteMany({
				where: { platformStaffId: { in: staffIds } },
			});
			await transaction.platformTotpCredential.deleteMany({
				where: { platformStaffId: { in: staffIds } },
			});
			await transaction.platformStaffRole.deleteMany({
				where: { platformStaffId: { in: staffIds } },
			});
			await transaction.platformStaff.deleteMany({ where: { id: { in: staffIds } } });
			await transaction.passwordCredential.deleteMany({ where: { userId: { in: userIds } } });
			await transaction.user.deleteMany({ where: { id: { in: userIds } } });
			await transaction.platformRolePermission.deleteMany({
				where: { platformRoleId: fixtureRoleId },
			});
			await transaction.platformRole.deleteMany({ where: { id: fixtureRoleId } });
			await transaction.platformPermission.deleteMany({
				where: { id: { in: [fixturePermissionId, extraPermissionId] } },
			});
		}, transactionOptions);
		fixtureEmails.clear();
	});

	afterAll(async () => {
		releaseLease.resolve(undefined);
		try {
			if (lease !== undefined) expect(await lease).toBeUndefined();
		} finally {
			await disconnect?.();
		}
	});

	it('acquires a real lock, excludes initialization while held, and releases on commit', async () => {
		await prisma.$transaction(async (holder) => {
			await acquireBootstrapLock(holder);
			await expect(initialize()).rejects.toMatchObject({ code: 'BOOTSTRAP_CONCURRENT_OPERATION' });
			expect(await prisma.platformStaff.count()).toBe(0);
		}, transactionOptions);
		// A different pool guarantees the release probe cannot re-enter a session's own lock.
		await observer.$transaction(
			(transaction) => acquireBootstrapLock(transaction),
			transactionOptions,
		);
		await expect(initialize()).resolves.toHaveProperty('secret');
	});

	it('releases the real lock on rollback and a database error leaves no owner', async () => {
		await expect(
			prisma.$transaction(async (transaction) => {
				await acquireBootstrapLock(transaction);
				await transaction.$queryRaw`SELECT 1 / 0`;
			}, transactionOptions),
		).rejects.toThrow();
		await observer.$transaction(
			(transaction) => acquireBootstrapLock(transaction),
			transactionOptions,
		);
		expect(await prisma.platformStaff.count()).toBe(0);
		await expect(initialize()).resolves.toHaveProperty('secret');
	});

	it('allows exactly one of two simultaneous first-owner attempts', async () => {
		const results = await Promise.allSettled([initialize(), initialize()]);
		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(await prisma.platformStaff.count()).toBe(1);
		expect(await prisma.user.count({ where: { email: { in: [...fixtureEmails] } } })).toBe(1);
	});

	it('rolls back owner writes when PostgreSQL rejects a read-only transaction', async () => {
		const module = await Test.createTestingModule({
			providers: [
				PlatformOwnerBootstrapService,
				{ provide: ConfigService, useValue: config },
				{ provide: PlatformPasswordService, useValue: new PlatformPasswordService(config) },
				{ provide: PlatformTokenService, useValue: new PlatformTokenService(config) },
				{ provide: PlatformTotpService, useValue: new PlatformTotpService(config) },
				{
					provide: PrismaService,
					useValue: {
						$transaction: (
							operation: (transaction: Prisma.TransactionClient) => Promise<unknown>,
							options: typeof transactionOptions,
						) =>
							prisma.$transaction(async (transaction) => {
								await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
								return await operation(transaction);
							}, options),
					},
				},
			],
		}).compile();
		try {
			await expect(initialize(module.get(PlatformOwnerBootstrapService))).rejects.toMatchObject({
				code: 'BOOTSTRAP_DATABASE_FAILED',
			});
			expect(await prisma.user.count({ where: { email: { in: [...fixtureEmails] } } })).toBe(0);
			expect(await prisma.platformStaff.count()).toBe(0);
		} finally {
			await module.close();
		}
	});

	it('rejects unexpected connected database identity without writing an owner', async () => {
		const wrongConfig = new ConfigService<EnvironmentVariables, true>({
			...environment,
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME: 'unexpected_database',
		});
		await expect(initialize(createService(wrongConfig))).rejects.toMatchObject({
			code: 'BOOTSTRAP_UNSAFE_DATABASE',
		});
		expect(await prisma.platformStaff.count()).toBe(0);
	});

	it('rejects a mismatched provisioned marker before writing an owner', async () => {
		const wrongConfig = new ConfigService<EnvironmentVariables, true>({
			...environment,
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER: `akiba:disposable-bootstrap-test:${randomUUID()}`,
		});
		await expect(initialize(createService(wrongConfig))).rejects.toMatchObject({
			code: 'BOOTSTRAP_UNSAFE_DATABASE',
		});
		expect(await prisma.platformStaff.count()).toBe(0);
	});

	it('rolls back partial owner, credentials, and role links after a late failure', async () => {
		class FailingTotpService extends PlatformTotpService {
			override createEnrollment(): never {
				throw new Error('Fictional enrollment failure');
			}
		}
		await expect(
			initialize(createService(config, new FailingTotpService(config))),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_DATABASE_FAILED' });
		expect(await prisma.user.count({ where: { email: { in: [...fixtureEmails] } } })).toBe(0);
		expect(await prisma.platformStaff.count()).toBe(0);
		expect(
			await prisma.platformRolePermission.count({ where: { platformRoleId: fixtureRoleId } }),
		).toBe(0);
		await expect(initialize()).resolves.toHaveProperty('secret');
	});

	it('refuses repeated initialization and preserves existing roles and permissions', async () => {
		const role = await prisma.platformRole.findUnique({ where: { id: fixtureRoleId } });
		const permission = await prisma.platformPermission.findUnique({
			where: { id: fixturePermissionId },
		});
		await initialize();
		await expect(initialize()).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_INITIALIZED' });
		expect(await prisma.platformRole.findUnique({ where: { id: fixtureRoleId } })).toEqual(role);
		expect(
			await prisma.platformPermission.findUnique({ where: { id: fixturePermissionId } }),
		).toEqual(permission);
	});

	it('rejects an unauthorized permission on the existing owner role without altering it', async () => {
		await prisma.platformPermission.create({
			data: {
				id: extraPermissionId,
				key: `fixture.${randomUUID()}`,
				description: 'Fictional unapproved permission',
			},
		});
		await prisma.platformRolePermission.create({
			data: { platformRoleId: fixtureRoleId, platformPermissionId: extraPermissionId },
		});
		await expect(initialize()).rejects.toMatchObject({ code: 'BOOTSTRAP_ROLE_CONFLICT' });
		expect(
			await prisma.platformRolePermission.count({
				where: { platformRoleId: fixtureRoleId, platformPermissionId: extraPermissionId },
			}),
		).toBe(1);
		expect(await prisma.platformStaff.count()).toBe(0);
	});

	it('requires mailbox confirmation and real TOTP verification before activation', async () => {
		const owner = await initialize();
		const code = new OTPAuth.TOTP({
			secret: OTPAuth.Secret.fromBase32(owner.secret),
			algorithm: 'SHA1',
			digits: 6,
			period: 30,
		}).generate();
		await expect(
			service.activate({ email: owner.email, totpCode: code, emailOwnershipVerified: false }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_INVALID_INPUT' });
		// A syntactically valid, deterministically wrong code must fail the actual verifier.
		const totp = new PlatformTotpService(config);
		const credential = await prisma.platformTotpCredential.findFirstOrThrow({
			where: { platformStaff: { user: { email: owner.email } } },
		});
		const now = new Date();
		const wrongCode = ['000000', '111111', '222222', '333333'].find(
			(candidate) => totp.verify(credential, candidate, now) === null,
		);
		if (wrongCode === undefined) throw new Error('Could not select an invalid fixture TOTP code.');
		await expect(
			service.activate({ email: owner.email, totpCode: wrongCode, emailOwnershipVerified: true }),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_MFA_REJECTED' });
		expect((await prisma.user.findUniqueOrThrow({ where: { email: owner.email } })).status).toBe(
			UserStatus.PENDING,
		);
		const freshCode = new OTPAuth.TOTP({
			secret: OTPAuth.Secret.fromBase32(owner.secret),
			algorithm: 'SHA1',
			digits: 6,
			period: 30,
		}).generate();
		const activated = await service.activate({
			email: owner.email,
			totpCode: freshCode,
			emailOwnershipVerified: true,
		});
		const recovery = await prisma.platformRecoveryCode.findMany({
			where: { platformStaffId: credential.platformStaffId },
		});
		expect(recovery).toHaveLength(10);
		const tokens = new PlatformTokenService(config);
		expect(recovery.map(({ codeDigest }) => codeDigest).sort()).toEqual(
			activated.recoveryCodes.map((value) => tokens.digest(value)).sort(),
		);
		expect(
			(await prisma.platformTotpCredential.findUniqueOrThrow({ where: { id: credential.id } }))
				.verifiedAt,
		).not.toBeNull();
		expect((await prisma.user.findUniqueOrThrow({ where: { email: owner.email } })).status).toBe(
			UserStatus.ACTIVE,
		);
	});
});

function requireValue(name: string, value: string | null | undefined): string {
	if (!value) throw new Error(`${name} is required for disposable bootstrap tests.`);
	return value;
}

function databaseTarget(url: URL): string {
	const hostname = url.hostname.toLowerCase().replace(/-pooler(?=\.)/u, '');
	return `${hostname === '127.0.0.1' ? 'localhost' : hostname}:${url.port || '5432'}${decodeURIComponent(url.pathname)}`;
}

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => {
		throw new Error('The deferred promise has not been constructed.');
	};
	let reject: (reason: Error) => void = () => {
		throw new Error('The deferred promise has not been constructed.');
	};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
