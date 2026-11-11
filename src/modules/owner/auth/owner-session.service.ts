import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	OrganizationMembershipStatus,
	OrganizationOwnerEnrollmentStatus,
	OrganizationStatus,
	OwnerSessionAssurance,
	Prisma,
	PrismaService,
} from '@nexcoderw/akiba-db';

import { databaseErrorCode } from '../../../common/errors/database-error-code.js';
import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { OWNER_AUTH_ERROR } from './owner-auth.constants.js';
import type { OwnerPrincipal } from './owner-auth.types.js';
import { OwnerTokenService } from './owner-token.service.js';

const MAXIMUM_ATTEMPTS = 3;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 10_000;
const CONNECTION_RETRY_WINDOW_MS = 1_000;
const MAX_ACTIVE_SESSIONS_PER_USER = 20;

export type OwnerSessionBinding =
	| {
			readonly organizationId: string;
			readonly membershipId: string;
			readonly enrollmentChallengeId?: never;
	  }
	| {
			readonly organizationId: string;
			readonly membershipId?: never;
			readonly enrollmentChallengeId: string;
	  };

@Injectable()
export class OwnerSessionService {
	private readonly sessionLifetimeMilliseconds: number;
	private readonly idleLifetimeMilliseconds: number;
	private readonly transactionMaxWaitMilliseconds: number;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly tokens: OwnerTokenService,
	) {
		this.sessionLifetimeMilliseconds =
			config.get('OWNER_AUTH_SESSION_TTL_SECONDS', { infer: true }) * 1000;
		this.idleLifetimeMilliseconds =
			config.get('OWNER_AUTH_IDLE_TTL_SECONDS', { infer: true }) * 1000;
		this.transactionMaxWaitMilliseconds = Math.min(
			config.get('DATABASE_CONNECTION_TIMEOUT_MS', { infer: true }),
			TRANSACTION_MAX_WAIT_MS,
		);
	}

	async create(
		userId: string,
		binding: OwnerSessionBinding,
		assurance: OwnerSessionAssurance,
		now = new Date(),
	): Promise<{ readonly token: string; readonly expiresAt: Date }> {
		const token = this.tokens.create();
		const expiresAt = new Date(now.getTime() + this.sessionLifetimeMilliseconds);
		await this.prisma.$transaction(
			async (transaction) => {
				// Recheck after password work and lock both rows against credential/account replacement.
				const eligible = await transaction.$queryRaw<{ id: string }[]>`
				SELECT account.id FROM public.users AS account
				JOIN public.password_credentials AS credential ON credential.user_id = account.id
				WHERE account.id = ${userId}::uuid AND account.status = 'active'
				AND account.email_verified_at IS NOT NULL AND credential.disabled_at IS NULL
				AND credential.password_changed_at <= ${now}
				FOR UPDATE OF account FOR SHARE OF credential
			`;
				if (eligible.length !== 1) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
				if (binding.membershipId !== undefined) {
					const membership = await transaction.organizationMembership.findFirst({
						where: {
							id: binding.membershipId,
							organizationId: binding.organizationId,
							userId,
							status: OrganizationMembershipStatus.ACTIVE,
							organization: { status: OrganizationStatus.ACTIVE },
							roles: { some: { organizationRole: { isActive: true } } },
						},
						select: { id: true },
					});
					if (membership === null) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
				} else {
					const challenge = await transaction.organizationOwnerEnrollmentChallenge.findFirst({
						where: {
							id: binding.enrollmentChallengeId,
							organizationId: binding.organizationId,
							userId,
							status: OrganizationOwnerEnrollmentStatus.VERIFIED,
							expiresAt: { gt: now },
							consumedAt: null,
						},
						select: { id: true },
					});
					if (challenge === null) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
				}
				const activeSessions = await transaction.ownerSession.count({
					where: {
						userId,
						revokedAt: null,
						idleExpiresAt: { gt: now },
						absoluteExpiresAt: { gt: now },
					},
				});
				if (activeSessions >= MAX_ACTIVE_SESSIONS_PER_USER)
					throw new ApiProblemException('RATE_LIMITED');
				await transaction.ownerSession.create({
					data: {
						userId,
						organizationId: binding.organizationId,
						membershipId: binding.membershipId ?? null,
						enrollmentChallengeId: binding.enrollmentChallengeId ?? null,
						tokenDigest: this.tokens.sessionDigest(token),
						assurance,
						authenticatedAt: now,
						mfaVerifiedAt: assurance === OwnerSessionAssurance.AAL2 ? now : null,
						createdAt: now,
						lastActivityAt: now,
						idleExpiresAt: new Date(
							Math.min(expiresAt.getTime(), now.getTime() + this.idleLifetimeMilliseconds),
						),
						absoluteExpiresAt: expiresAt,
					},
				});
			},
			{ maxWait: this.transactionMaxWaitMilliseconds, timeout: TRANSACTION_TIMEOUT_MS },
		);
		return { token, expiresAt };
	}

	async authenticate(token: string, now = new Date()): Promise<OwnerPrincipal> {
		const digest = this.tokens.sessionDigest(token);
		const startedAt = performance.now();
		for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
			const transactionState = { started: false };
			try {
				return await this.authenticateTransaction(digest, now, () => {
					transactionState.started = true;
				});
			} catch (error: unknown) {
				const code = databaseErrorCode(error);
				// Retry one fast connection failure only before any session work could execute.
				// Never replay an uncertain refresh/revocation or multiply slow connection timeouts.
				const retryConnection =
					code === 'P1001' &&
					!transactionState.started &&
					attempt === 0 &&
					performance.now() - startedAt < CONNECTION_RETRY_WINDOW_MS;
				if ((code === 'P2034' || retryConnection) && attempt + 1 < MAXIMUM_ATTEMPTS) {
					await delay(randomInt(75, 201) * (attempt + 1));
					continue;
				}
				if (
					code !== undefined &&
					['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034', 'P2037'].includes(code)
				) {
					throw new ServiceUnavailableException(
						{
							code: 'OWNER_SESSION_UNAVAILABLE',
							message: 'Session verification is temporarily unavailable.',
						},
						{ cause: error },
					);
				}
				throw error;
			}
		}
		throw new ServiceUnavailableException('Session verification is temporarily unavailable.');
	}

	async revoke(token: string | undefined, now = new Date()): Promise<void> {
		if (token === undefined || !this.tokens.isValid(token)) return;
		await this.prisma.ownerSession.updateMany({
			where: { tokenDigest: this.tokens.sessionDigest(token), revokedAt: null },
			data: { revokedAt: now, revocationReason: 'logout' },
		});
	}

	/** Return only safe metadata for sessions in the caller's current membership. */
	async listActive(
		token: string,
		now = new Date(),
	): Promise<
		readonly {
			readonly id: string;
			readonly createdAt: Date;
			readonly lastActivityAt: Date;
			readonly expiresAt: Date;
			readonly current: boolean;
		}[]
	> {
		const principal = await this.authenticate(token, now);
		const access = principal.organizations[0];
		if (access === undefined) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		const rows = await this.prisma.ownerSession.findMany({
			where: {
				userId: principal.userId,
				organizationId: access.organizationId,
				membershipId: access.membershipId,
				revokedAt: null,
				idleExpiresAt: { gt: now },
				absoluteExpiresAt: { gt: now },
			},
			select: { id: true, createdAt: true, lastActivityAt: true, absoluteExpiresAt: true },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: MAX_ACTIVE_SESSIONS_PER_USER,
		});
		return rows.map((row) => ({
			id: row.id,
			createdAt: row.createdAt,
			lastActivityAt: row.lastActivityAt,
			expiresAt: row.absoluteExpiresAt,
			current: row.id === principal.sessionId,
		}));
	}

	/** A bearer can revoke only sessions belonging to its own user and membership. */
	async revokeSelected(token: string, sessionId: string, now = new Date()): Promise<boolean> {
		const principal = await this.authenticate(token, now);
		const access = principal.organizations[0];
		if (access === undefined) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)
		)
			return false;
		const result = await this.prisma.ownerSession.updateMany({
			where: {
				id: sessionId,
				userId: principal.userId,
				organizationId: access.organizationId,
				membershipId: access.membershipId,
				revokedAt: null,
			},
			data: { revokedAt: now, revocationReason: 'remote' },
		});
		return result.count === 1;
	}

	async revokeOther(token: string, now = new Date()): Promise<number> {
		const principal = await this.authenticate(token, now);
		const access = principal.organizations[0];
		if (access === undefined) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		const result = await this.prisma.ownerSession.updateMany({
			where: {
				id: { not: principal.sessionId },
				userId: principal.userId,
				organizationId: access.organizationId,
				membershipId: access.membershipId,
				revokedAt: null,
			},
			data: { revokedAt: now, revocationReason: 'all_sessions' },
		});
		return result.count;
	}

	/** A verified user may terminate every one of their own organization sessions. */
	async revokeAll(token: string, now = new Date()): Promise<number> {
		const principal = await this.authenticate(token, now);
		if (principal.organizations[0] === undefined)
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		const result = await this.prisma.ownerSession.updateMany({
			where: { userId: principal.userId, revokedAt: null },
			data: { revokedAt: now, revocationReason: 'all_sessions' },
		});
		return result.count;
	}

	async rotate(
		token: string,
		now = new Date(),
	): Promise<{ readonly token: string; readonly expiresAt: Date }> {
		const principal = await this.authenticate(token, now);
		const access = principal.organizations[0];
		if (access === undefined) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		const replacement = this.tokens.create();
		return this.prisma.$transaction(
			async (transaction) => {
				const old = await transaction.ownerSession.findUnique({
					where: { id: principal.sessionId },
					select: { authenticatedAt: true, mfaVerifiedAt: true, absoluteExpiresAt: true },
				});
				if (old === null || old.absoluteExpiresAt <= now)
					throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
				const changed = await transaction.ownerSession.updateMany({
					where: {
						id: principal.sessionId,
						tokenDigest: this.tokens.sessionDigest(token),
						userId: principal.userId,
						organizationId: access.organizationId,
						membershipId: access.membershipId,
						revokedAt: null,
						idleExpiresAt: { gt: now },
						absoluteExpiresAt: { gt: now },
					},
					data: { revokedAt: now, revocationReason: 'rotated' },
				});
				if (changed.count !== 1) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
				await transaction.ownerSession.create({
					data: {
						userId: principal.userId,
						organizationId: access.organizationId,
						membershipId: access.membershipId,
						tokenDigest: this.tokens.sessionDigest(replacement),
						assurance: principal.assurance,
						authenticatedAt: old.authenticatedAt,
						mfaVerifiedAt: old.mfaVerifiedAt,
						createdAt: now,
						lastActivityAt: now,
						idleExpiresAt: new Date(
							Math.min(
								old.absoluteExpiresAt.getTime(),
								now.getTime() + this.idleLifetimeMilliseconds,
							),
						),
						absoluteExpiresAt: old.absoluteExpiresAt,
					},
				});
				return { token: replacement, expiresAt: old.absoluteExpiresAt };
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: this.transactionMaxWaitMilliseconds,
				timeout: TRANSACTION_TIMEOUT_MS,
			},
		);
	}

	private async authenticateTransaction(
		tokenDigest: string,
		now: Date,
		onStarted: () => void,
	): Promise<OwnerPrincipal> {
		const principal = await this.prisma.$transaction(
			async (transaction): Promise<OwnerPrincipal | null> => {
				onStarted();
				const session = await transaction.ownerSession.findUnique({
					where: { tokenDigest },
					select: {
						id: true,
						organizationId: true,
						membershipId: true,
						enrollmentChallengeId: true,
						assurance: true,
						authenticatedAt: true,
						idleExpiresAt: true,
						absoluteExpiresAt: true,
						revokedAt: true,
						membership: {
							select: {
								id: true,
								status: true,
								organization: { select: { id: true, name: true, slug: true, status: true } },
								roles: {
									where: { organizationRole: { isActive: true } },
									select: { organizationRole: { select: { key: true } } },
								},
							},
						},
						enrollmentChallenge: {
							select: { id: true, status: true, expiresAt: true, consumedAt: true },
						},
						user: {
							select: {
								id: true,
								displayName: true,
								email: true,
								status: true,
								emailVerifiedAt: true,
								passwordCredential: { select: { passwordChangedAt: true, disabledAt: true } },
							},
						},
					},
				});
				if (session === null) return null;
				const invalid =
					session.revokedAt !== null ||
					session.organizationId === null ||
					(session.membershipId === null && session.enrollmentChallengeId === null) ||
					(session.membershipId !== null && session.enrollmentChallengeId !== null) ||
					(session.membershipId !== null &&
						(session.membership === null ||
							session.membership.id !== session.membershipId ||
							session.membership.organization.id !== session.organizationId ||
							session.membership.status !== OrganizationMembershipStatus.ACTIVE ||
							session.membership.organization.status !== OrganizationStatus.ACTIVE)) ||
					(session.enrollmentChallengeId !== null &&
						(session.enrollmentChallenge === null ||
							session.enrollmentChallenge.id !== session.enrollmentChallengeId ||
							session.enrollmentChallenge.status !== OrganizationOwnerEnrollmentStatus.VERIFIED ||
							session.enrollmentChallenge.consumedAt !== null ||
							session.enrollmentChallenge.expiresAt <= now)) ||
					session.idleExpiresAt <= now ||
					session.absoluteExpiresAt <= now ||
					!accountCanAuthenticate(session.user.status, session.user.emailVerifiedAt) ||
					session.user.passwordCredential === null ||
					session.user.passwordCredential.disabledAt !== null ||
					session.user.passwordCredential.passwordChangedAt > session.authenticatedAt;
				if (invalid) {
					if (session.revokedAt === null) {
						const reason =
							session.idleExpiresAt <= now || session.absoluteExpiresAt <= now
								? 'expired'
								: 'invalidated';
						await transaction.ownerSession.updateMany({
							where: { id: session.id, revokedAt: null },
							data: { revokedAt: now, revocationReason: reason },
						});
					}
					return null;
				}

				const idleExpiresAt = new Date(
					Math.min(
						session.absoluteExpiresAt.getTime(),
						now.getTime() + this.idleLifetimeMilliseconds,
					),
				);
				if (idleExpiresAt.getTime() - session.idleExpiresAt.getTime() >= 30_000) {
					const refreshed = await transaction.ownerSession.updateMany({
						where: {
							id: session.id,
							revokedAt: null,
							idleExpiresAt: { gt: now },
							absoluteExpiresAt: { gt: now },
						},
						data: { lastActivityAt: now, idleExpiresAt },
					});
					if (refreshed.count !== 1) return null;
				}

				return {
					sessionId: session.id,
					userId: session.user.id,
					displayName: session.user.displayName,
					email: session.user.email,
					assurance: session.assurance,
					expiresAt: session.absoluteExpiresAt,
					enrollmentChallengeId: session.enrollmentChallengeId ?? undefined,
					organizations:
						session.membership === null
							? []
							: [
									{
										organizationId: session.membership.organization.id,
										name: session.membership.organization.name,
										slug: session.membership.organization.slug,
										status: session.membership.organization.status,
										membershipId: session.membership.id,
										roles: session.membership.roles.map(
											({ organizationRole }) => organizationRole.key,
										),
									},
								],
				};
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: this.transactionMaxWaitMilliseconds,
				timeout: TRANSACTION_TIMEOUT_MS,
			},
		);
		if (principal === null) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
		return principal;
	}
}
