import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	OrganizationMembershipStatus,
	OwnerSessionAssurance,
	Prisma,
	PrismaService,
} from '@nexcoderw/akiba-db';

import { databaseErrorCode } from '../../../common/errors/database-error-code.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { OWNER_AUTH_ERROR } from './owner-auth.constants.js';
import type { OwnerPrincipal } from './owner-auth.types.js';
import { OwnerTokenService } from './owner-token.service.js';

const MAXIMUM_ATTEMPTS = 3;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 10_000;
const CONNECTION_RETRY_WINDOW_MS = 1_000;

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
				FOR SHARE OF account, credential
			`;
				if (eligible.length !== 1) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidSession);
				await transaction.ownerSession.create({
					data: {
						userId,
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
			data: { revokedAt: now },
		});
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
						assurance: true,
						authenticatedAt: true,
						idleExpiresAt: true,
						absoluteExpiresAt: true,
						revokedAt: true,
						user: {
							select: {
								id: true,
								displayName: true,
								email: true,
								status: true,
								emailVerifiedAt: true,
								passwordCredential: { select: { passwordChangedAt: true, disabledAt: true } },
								organizationMemberships: {
									where: { status: OrganizationMembershipStatus.ACTIVE },
									select: {
										id: true,
										organization: {
											select: { id: true, name: true, slug: true, status: true },
										},
										roles: { select: { organizationRole: { select: { key: true } } } },
									},
								},
							},
						},
					},
				});
				if (session === null) return null;
				const invalid =
					session.revokedAt !== null ||
					session.idleExpiresAt <= now ||
					session.absoluteExpiresAt <= now ||
					!accountCanAuthenticate(session.user.status, session.user.emailVerifiedAt) ||
					session.user.passwordCredential?.disabledAt !== null ||
					session.user.passwordCredential.passwordChangedAt > session.authenticatedAt;
				if (invalid) {
					if (session.revokedAt === null) {
						await transaction.ownerSession.updateMany({
							where: { id: session.id, revokedAt: null },
							data: { revokedAt: now },
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
					organizations: session.user.organizationMemberships.map((membership) => ({
						organizationId: membership.organization.id,
						name: membership.organization.name,
						slug: membership.organization.slug,
						status: membership.organization.status,
						membershipId: membership.id,
						roles: membership.roles.map(({ organizationRole }) => organizationRole.key),
					})),
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
