import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { UserStatus } from '@nexcoderw/akiba-db';

interface UserRow {
	id: string;
	email: string;
	displayName: string;
	status: UserStatus;
	emailVerifiedAt: Date | null;
	identityVersion: number;
	createdAt: Date;
	updatedAt: Date;
}
interface CredentialRow {
	id: string;
	userId: string;
	passwordHash: string;
	normalization: string;
	version: number;
	disabledAt: Date | null;
	passwordChangedAt: Date;
	createdAt: Date;
	updatedAt: Date;
}
interface ProofRow {
	id: string;
	userId: string;
	identityVersion: number;
	targetEmail: string;
	tokenDigest: string;
	createdAt: Date;
	expiresAt: Date;
	consumedAt: Date | null;
}
type UserData = Partial<Omit<UserRow, 'identityVersion'>> & {
	identityVersion?: number | { increment: number };
};
type CredentialData = Partial<Omit<CredentialRow, 'version'>> & {
	version?: number | { increment: number };
};

function databaseError(code: string): Error & { code: string } {
	return Object.assign(new Error('Synthetic database constraint failure.'), { code });
}

/** Serial in-memory adapter with rollback and projection, not evidence of PostgreSQL constraints. */
export function createIdentityDatabaseFixture() {
	const state = {
		users: new Map<string, UserRow>(),
		credentials: new Map<string, CredentialRow>(),
		proofs: new Map<string, ProofRow>(),
		events: [] as Record<string, unknown>[],
		failAudit: false,
		revocations: [] as { table: string; where: unknown }[],
	};
	const project = (
		row: Record<string, unknown>,
		select?: Record<string, unknown>,
	): Record<string, unknown> =>
		Object.fromEntries(
			Object.entries(row).filter(([key]) => select === undefined || select[key] === true),
		);
	const revoker = (table: string) =>
		jest
			.fn<(args: { where: unknown }) => Promise<{ count: number }>>()
			.mockImplementation((args) => {
				state.revocations.push({ table, where: args.where });
				return Promise.resolve({ count: 1 });
			});
	const client = {
		$queryRaw: jest
			.fn<(...args: unknown[]) => Promise<unknown[]>>()
			.mockImplementation(() => Promise.resolve([{ now: new Date() }])),
		user: {
			findUnique: jest
				.fn<
					(args: {
						where: { id?: string; email?: string };
						select?: Record<string, unknown>;
					}) => Promise<unknown>
				>()
				.mockImplementation((args) => {
					const user =
						args.where.id === undefined
							? [...state.users.values()].find(
									(item) => item.email.toLowerCase() === args.where.email?.toLowerCase(),
								)
							: state.users.get(args.where.id);
					return Promise.resolve(
						user === undefined
							? null
							: project(
									structuredClone({
										...user,
										passwordCredential: state.credentials.get(user.id) ?? null,
									}),
									args.select,
								),
					);
				}),
			create: jest
				.fn<
					(args: {
						data: { email: string; displayName: string };
						select?: Record<string, unknown>;
					}) => Promise<unknown>
				>()
				.mockImplementation((args) => {
					if (
						[...state.users.values()].some(
							(item) => item.email.toLowerCase() === args.data.email.toLowerCase(),
						)
					)
						return Promise.reject(databaseError('P2002'));
					const now = new Date();
					const user: UserRow = {
						id: randomUUID(),
						...args.data,
						status: UserStatus.PENDING,
						emailVerifiedAt: null,
						identityVersion: 1,
						createdAt: now,
						updatedAt: now,
					};
					state.users.set(user.id, user);
					return Promise.resolve(project({ ...user }, args.select));
				}),
			updateMany: jest
				.fn<
					(args: {
						where: { id: string; identityVersion?: number; status?: UserStatus };
						data: UserData;
					}) => Promise<{ count: number }>
				>()
				.mockImplementation((args) => {
					const user = state.users.get(args.where.id);
					if (
						user === undefined ||
						(args.where.identityVersion !== undefined &&
							user.identityVersion !== args.where.identityVersion) ||
						(args.where.status !== undefined && user.status !== args.where.status)
					)
						return Promise.resolve({ count: 0 });
					if (
						args.data.email !== undefined &&
						[...state.users.values()].some(
							(item) =>
								item.id !== user.id && item.email.toLowerCase() === args.data.email?.toLowerCase(),
						)
					)
						return Promise.reject(databaseError('P2002'));
					const { identityVersion, ...data } = args.data;
					Object.assign(user, data);
					if (identityVersion !== undefined)
						user.identityVersion =
							typeof identityVersion === 'number'
								? identityVersion
								: user.identityVersion + identityVersion.increment;
					return Promise.resolve({ count: 1 });
				}),
			update: jest
				.fn<(args: { where: { id: string }; data: UserData }) => Promise<unknown>>()
				.mockImplementation((args) => {
					const user = state.users.get(args.where.id);
					if (user === undefined) return Promise.reject(databaseError('P2025'));
					const { identityVersion, ...data } = args.data;
					Object.assign(user, data);
					if (identityVersion !== undefined)
						user.identityVersion =
							typeof identityVersion === 'number'
								? identityVersion
								: user.identityVersion + identityVersion.increment;
					return Promise.resolve(user);
				}),
		},
		passwordCredential: {
			findUnique: jest
				.fn<(args: { where: { userId: string } }) => Promise<CredentialRow | null>>()
				.mockImplementation((args) =>
					Promise.resolve(structuredClone(state.credentials.get(args.where.userId) ?? null)),
				),
			create: jest
				.fn<
					(args: {
						data: {
							userId: string;
							passwordHash: string;
							normalization: string;
							passwordChangedAt: Date;
						};
					}) => Promise<CredentialRow>
				>()
				.mockImplementation((args) => {
					if (state.credentials.has(args.data.userId))
						return Promise.reject(databaseError('P2002'));
					const row: CredentialRow = {
						id: randomUUID(),
						...args.data,
						version: 1,
						disabledAt: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					};
					state.credentials.set(row.userId, row);
					return Promise.resolve(row);
				}),
			updateMany: jest
				.fn<
					(args: {
						where: { userId: string; version?: number; passwordHash?: string; disabledAt?: null };
						data: CredentialData;
					}) => Promise<{ count: number }>
				>()
				.mockImplementation((args) => {
					const row = state.credentials.get(args.where.userId);
					if (
						row === undefined ||
						(args.where.version !== undefined && row.version !== args.where.version) ||
						(args.where.passwordHash !== undefined &&
							row.passwordHash !== args.where.passwordHash) ||
						(args.where.disabledAt === null && row.disabledAt !== null)
					)
						return Promise.resolve({ count: 0 });
					const { version, ...data } = args.data;
					Object.assign(row, data);
					if (version !== undefined)
						row.version = typeof version === 'number' ? version : row.version + version.increment;
					return Promise.resolve({ count: 1 });
				}),
		},
		userEmailVerificationChallenge: {
			findUnique: jest
				.fn<(args: { where: { tokenDigest: string } }) => Promise<ProofRow | null>>()
				.mockImplementation((args) =>
					Promise.resolve(
						structuredClone(
							[...state.proofs.values()].find(
								(item) => item.tokenDigest === args.where.tokenDigest,
							) ?? null,
						),
					),
				),
			create: jest
				.fn<(args: { data: Omit<ProofRow, 'id' | 'consumedAt'> }) => Promise<ProofRow>>()
				.mockImplementation((args) => {
					const row = { id: randomUUID(), consumedAt: null, ...args.data };
					state.proofs.set(row.id, row);
					return Promise.resolve(row);
				}),
			updateMany: jest
				.fn<
					(args: {
						where: { userId?: string; id?: string; consumedAt?: null; expiresAt?: { gt: Date } };
						data: { consumedAt: Date };
					}) => Promise<{ count: number }>
				>()
				.mockImplementation((args) => {
					let count = 0;
					for (const row of state.proofs.values()) {
						if (
							(args.where.userId === undefined || row.userId === args.where.userId) &&
							(args.where.id === undefined || row.id === args.where.id) &&
							row.consumedAt === null &&
							(args.where.expiresAt === undefined || row.expiresAt > args.where.expiresAt.gt)
						) {
							row.consumedAt = args.data.consumedAt;
							count += 1;
						}
					}
					return Promise.resolve({ count });
				}),
		},
		identitySecurityAuditEvent: {
			create: jest
				.fn<(args: { data: Record<string, unknown> }) => Promise<{ id: string }>>()
				.mockImplementation((args) => {
					if (state.failAudit) return Promise.reject(new Error('private audit failure'));
					state.events.push(args.data);
					return Promise.resolve({ id: randomUUID() });
				}),
		},
		ownerSession: { updateMany: revoker('owner') },
		platformAdminSession: { updateMany: revoker('platform') },
		platformMfaChallenge: { updateMany: revoker('mfa') },
		organizationOwnerEnrollmentChallenge: { updateMany: revoker('enrollment') },
	};
	let tail = Promise.resolve();
	const transaction = jest
		.fn<(operation: (transaction: typeof client) => Promise<unknown>) => Promise<unknown>>()
		.mockImplementation(async (operation) => {
			const previous = tail;
			let release: (() => void) | undefined;
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			const snapshot = structuredClone(state);
			try {
				return await operation(client);
			} catch (error: unknown) {
				Object.assign(state, snapshot);
				throw error;
			} finally {
				release?.();
			}
		});
	return { state, client, transaction, prisma: { ...client, $transaction: transaction } };
}
