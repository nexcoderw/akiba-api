import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
	Injectable,
	ForbiddenException,
	Logger,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformStaffStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { databaseErrorCode } from '../../../common/errors/database-error-code.js';
import { PLATFORM_AUTH_ERROR } from './platform-auth.constants.js';
import type { PlatformPrincipal } from './platform-auth.types.js';
import { PlatformTokenService } from './platform-token.service.js';
import { effectivePlatformPermissions } from './platform-permission-policy.js';
import { PLATFORM_PERMISSION } from './platform-permission.constants.js';
import { recordPlatformAuthentication } from './platform-authentication-audit.js';

const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 10_000;
const AUTHENTICATION_BUDGET_MS = 18_000;
const AUTHENTICATION_MAX_ATTEMPTS = 3;

@Injectable()
export class PlatformSessionService {
	private readonly issued = new WeakMap<PlatformPrincipal, string>();
	private readonly logger = new Logger(PlatformSessionService.name);
	private readonly idleLifetimeMilliseconds: number;
	private readonly transactionMaxWaitMilliseconds: number;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly tokens: PlatformTokenService,
	) {
		this.idleLifetimeMilliseconds =
			config.get('PLATFORM_AUTH_IDLE_TTL_SECONDS', { infer: true }) * 1000;
		this.transactionMaxWaitMilliseconds = Math.min(
			config.get('DATABASE_CONNECTION_TIMEOUT_MS', { infer: true }),
			TRANSACTION_MAX_WAIT_MS,
		);
	}

	async authenticate(token: string, now = new Date()): Promise<PlatformPrincipal> {
		const tokenDigest = this.tokens.digest(token);
		const startedAt = performance.now();
		for (let attempt = 0; attempt < AUTHENTICATION_MAX_ATTEMPTS; attempt += 1) {
			const elapsed = performance.now() - startedAt;
			const remaining = Math.floor(AUTHENTICATION_BUDGET_MS - elapsed);
			if (remaining < 2_000) {
				throw new ServiceUnavailableException({
					code: 'PLATFORM_SESSION_UNAVAILABLE',
					message: 'Session verification is temporarily unavailable.',
				});
			}
			const maxWait = Math.min(this.transactionMaxWaitMilliseconds, remaining - 1_000);
			const timeout = Math.min(TRANSACTION_TIMEOUT_MS, remaining - maxWait);
			try {
				const principal = await this.authenticateTransaction(
					tokenDigest,
					attempt === 0 ? now : new Date(now.getTime() + elapsed),
					{ maxWait, timeout },
				);
				Object.freeze(principal.roles);
				Object.freeze(principal.permissions);
				Object.freeze(principal);
				this.issued.set(principal, tokenDigest);
				return principal;
			} catch (error: unknown) {
				const code = databaseErrorCode(error);
				// Only a confirmed rollback may be retried. Keep the total below the BFF deadline.
				if (
					code === 'P2034' &&
					attempt + 1 < AUTHENTICATION_MAX_ATTEMPTS &&
					performance.now() - startedAt < AUTHENTICATION_BUDGET_MS - 2_000
				) {
					// Parallel requests refresh the same session row. Jitter avoids synchronized retries.
					// The next iteration recomputes the budget and rechecks expiry and live permissions.
					await delay(randomInt(100, 251) * (attempt + 1));
					continue;
				}
				if (
					code !== undefined &&
					['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034', 'P2037'].includes(code)
				) {
					throw new ServiceUnavailableException(
						{
							code: 'PLATFORM_SESSION_UNAVAILABLE',
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

	/** Business entry points recheck live authority; copied principals are not credentials. */
	async authorize(
		principal: PlatformPrincipal | undefined,
		permission: string,
		actorPlatformStaffId?: string,
	): Promise<void> {
		const digest = principal === undefined ? undefined : this.issued.get(principal);
		if (
			principal === undefined ||
			digest === undefined ||
			!Object.values(PLATFORM_PERMISSION).some((value) => value === permission) ||
			(actorPlatformStaffId !== undefined && actorPlatformStaffId !== principal.platformStaffId)
		)
			throw new ForbiddenException({ code: 'ACCESS_DENIED', message: 'Access is denied.' });
		const current = await this.authenticateTransaction(digest, new Date(), {
			maxWait: this.transactionMaxWaitMilliseconds,
			timeout: TRANSACTION_TIMEOUT_MS,
		});
		if (
			current.sessionId !== principal.sessionId ||
			current.userId !== principal.userId ||
			current.platformStaffId !== principal.platformStaffId ||
			!current.permissions.includes(permission)
		)
			throw new ForbiddenException({ code: 'ACCESS_DENIED', message: 'Access is denied.' });
	}

	private async authenticateTransaction(
		tokenDigest: string,
		now: Date,
		budget: { readonly maxWait: number; readonly timeout: number },
	): Promise<PlatformPrincipal> {
		const principal = await this.prisma.$transaction(
			async (transaction): Promise<PlatformPrincipal | null> => {
				const session = await transaction.platformAdminSession.findUnique({
					where: { tokenDigest },
					select: {
						id: true,
						createdAt: true,
						expiresAt: true,
						idleExpiresAt: true,
						revokedAt: true,
						mfaVerifiedAt: true,
						platformStaff: {
							select: {
								id: true,
								status: true,
								user: {
									select: {
										id: true,
										email: true,
										displayName: true,
										status: true,
										emailVerifiedAt: true,
										passwordCredential: {
											select: { passwordChangedAt: true, disabledAt: true },
										},
									},
								},
								roles: {
									select: {
										platformRole: {
											select: {
												key: true,
												isSystem: true,
												permissions: {
													select: {
														platformPermission: { select: { key: true } },
													},
												},
											},
										},
									},
								},
							},
						},
					},
				});
				if (session === null) {
					return null;
				}

				const passwordChangedAt = session.platformStaff.user.passwordCredential?.passwordChangedAt;
				const roles = session.platformStaff.roles.map(({ platformRole }) => platformRole.key);
				const permissions = effectivePlatformPermissions(session.platformStaff.roles);
				const invalid =
					session.revokedAt !== null ||
					session.expiresAt <= now ||
					session.idleExpiresAt <= now ||
					session.mfaVerifiedAt > now ||
					session.platformStaff.status !== PlatformStaffStatus.ACTIVE ||
					!accountCanAuthenticate(
						session.platformStaff.user.status,
						session.platformStaff.user.emailVerifiedAt,
					) ||
					session.platformStaff.user.passwordCredential?.disabledAt !== null ||
					passwordChangedAt === undefined ||
					passwordChangedAt > session.createdAt ||
					permissions.length === 0;
				if (invalid) {
					if (session.revokedAt === null) {
						const reason =
							session.idleExpiresAt <= now || session.expiresAt <= now ? 'expired' : 'invalidated';
						await transaction.platformAdminSession.updateMany({
							where: { id: session.id, revokedAt: null },
							data: { revokedAt: now, revocationReason: reason },
						});
					}
					return null;
				}

				const idleExpiresAt = new Date(
					Math.min(session.expiresAt.getTime(), now.getTime() + this.idleLifetimeMilliseconds),
				);
				// Coalesce activity writes, not authorization reads. Every request checks live state.
				// This may shorten the idle window by at most 30 seconds; it never extends expiry.
				const refreshInterval = Math.min(30_000, this.idleLifetimeMilliseconds / 10);
				if (idleExpiresAt.getTime() - session.idleExpiresAt.getTime() >= refreshInterval) {
					const refreshed = await transaction.platformAdminSession.updateMany({
						where: {
							id: session.id,
							revokedAt: null,
							expiresAt: { gt: now },
							idleExpiresAt: { gt: now },
						},
						data: { lastSeenAt: now, idleExpiresAt },
					});
					if (refreshed.count !== 1) {
						return null;
					}
				}

				return {
					sessionId: session.id,
					userId: session.platformStaff.user.id,
					platformStaffId: session.platformStaff.id,
					displayName: session.platformStaff.user.displayName,
					email: session.platformStaff.user.email,
					expiresAt: session.expiresAt,
					roles,
					permissions,
				};
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				// Bound remote connection acquisition separately from session validation work.
				maxWait: budget.maxWait,
				timeout: budget.timeout,
			},
		);

		if (principal === null) {
			this.logger.warn(JSON.stringify({ event: 'platform_session_rejected' }));
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidSession);
		}
		return principal;
	}

	async revoke(token: string | undefined, now = new Date(), requestId?: string): Promise<void> {
		if (token === undefined || token.length < 32 || token.length > 256) {
			return;
		}
		const changed = await this.prisma
			.$transaction(
				async (transaction) => {
					const session = await transaction.platformAdminSession.findUnique({
						where: { tokenDigest: this.tokens.digest(token) },
						select: {
							id: true,
							revokedAt: true,
							platformStaff: { select: { user: { select: { id: true, identityVersion: true } } } },
						},
					});
					if (session === null || session.revokedAt !== null) return false;
					const revoked = await transaction.platformAdminSession.updateMany({
						where: { id: session.id, revokedAt: null },
						data: { revokedAt: now, revocationReason: 'logout' },
					});
					if (revoked.count === 1) {
						await recordPlatformAuthentication(
							transaction,
							session.platformStaff.user,
							'platform_session_revoked',
							requestId,
						);
					}
					return revoked.count === 1;
				},
				{ maxWait: this.transactionMaxWaitMilliseconds, timeout: TRANSACTION_TIMEOUT_MS },
			)
			.catch((error: unknown) => {
				throw new ServiceUnavailableException(
					{
						code: 'PLATFORM_SESSION_UNAVAILABLE',
						message: 'Session revocation is temporarily unavailable.',
					},
					{ cause: error },
				);
			});
		if (changed) this.logger.log(JSON.stringify({ event: 'platform_session_revoked', requestId }));
	}

	/** Internal session management; the presented platform token is always revalidated. */
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
		const rows = await this.prisma.platformAdminSession.findMany({
			where: {
				platformStaffId: principal.platformStaffId,
				revokedAt: null,
				idleExpiresAt: { gt: now },
				expiresAt: { gt: now },
			},
			select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: 20,
		});
		return rows.map((row) => ({
			id: row.id,
			createdAt: row.createdAt,
			lastActivityAt: row.lastSeenAt,
			expiresAt: row.expiresAt,
			current: row.id === principal.sessionId,
		}));
	}

	async revokeSelected(token: string, sessionId: string, now = new Date()): Promise<boolean> {
		const principal = await this.authenticate(token, now);
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)
		)
			return false;
		const result = await this.prisma.platformAdminSession.updateMany({
			where: { id: sessionId, platformStaffId: principal.platformStaffId, revokedAt: null },
			data: { revokedAt: now, revocationReason: 'remote' },
		});
		return result.count === 1;
	}

	async revokeOther(token: string, now = new Date()): Promise<number> {
		const principal = await this.authenticate(token, now);
		const result = await this.prisma.platformAdminSession.updateMany({
			where: {
				id: { not: principal.sessionId },
				platformStaffId: principal.platformStaffId,
				revokedAt: null,
			},
			data: { revokedAt: now, revocationReason: 'all_sessions' },
		});
		return result.count;
	}

	async revokeAll(token: string, now = new Date()): Promise<number> {
		const principal = await this.authenticate(token, now);
		const result = await this.prisma.platformAdminSession.updateMany({
			where: { platformStaffId: principal.platformStaffId, revokedAt: null },
			data: { revokedAt: now, revocationReason: 'all_sessions' },
		});
		return result.count;
	}
}
