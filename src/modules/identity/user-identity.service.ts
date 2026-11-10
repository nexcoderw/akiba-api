import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import {
	accountCanProvisionCredentials,
	canChangeAccountStatus,
} from '../../common/identity/account-state.policy.js';
import { normalizeEmailIdentity } from '../../common/identity/email-identity.js';
import { ApiProblemException } from '../../common/errors/api-problem.exception.js';
import { PlatformSessionService } from '../platform/auth/platform-session.service.js';
import {
	assertIdentityTarget,
	authorizeIdentityOperation,
	identityFailure,
	IDENTITY_TRANSACTION,
	lockIdentity,
	recordIdentityEvent,
	revokeIdentityAuthentication,
	type IdentityOperationContext,
} from './identity-security.js';

const PROFILE = Object.freeze({
	id: true,
	email: true,
	displayName: true,
	status: true,
	emailVerifiedAt: true,
	identityVersion: true,
} as const);
export interface IdentityProfile {
	readonly id: string;
	readonly email: string;
	readonly displayName: string;
	readonly status: UserStatus;
	readonly emailVerifiedAt: Date | null;
	readonly identityVersion: number;
}

function email(value: string): string {
	const normalized = normalizeEmailIdentity(value);
	if (normalized === null) throw new ApiProblemException('VALIDATION_FAILED');
	return normalized;
}

function proofDigest(token: string): string | null {
	if (
		!/^[A-Za-z0-9_-]{43}$/u.test(token) ||
		Buffer.from(token, 'base64url').toString('base64url') !== token
	)
		return null;
	return createHash('sha256')
		.update(JSON.stringify(['akiba-mailbox-proof-v1', token]))
		.digest('hex');
}

/** Internal global identity boundary. No controller, tenant repository or raw Prisma client is exported. */
@Injectable()
export class UserIdentityService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly sessions: PlatformSessionService,
	) {}

	async createPending(
		context: IdentityOperationContext,
		input: { readonly email: string; readonly displayName: string },
	): Promise<IdentityProfile> {
		const actor = await authorizeIdentityOperation(this.sessions, context);
		const normalized = email(input.email);
		const displayName = input.displayName.trim();
		if (displayName.length < 1 || displayName.length > 160 || /[\p{Cc}\p{Cs}]/u.test(displayName)) {
			throw new ApiProblemException('VALIDATION_FAILED');
		}
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const user = await transaction.user.create({
					data: { email: normalized, displayName },
					select: PROFILE,
				});
				await recordIdentityEvent(transaction, actor, {
					userId: user.id,
					action: 'identity_created',
					identityVersion: user.identityVersion,
				});
				return user;
			}, IDENTITY_TRANSACTION);
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}

	async profile(context: IdentityOperationContext, userId: string): Promise<IdentityProfile> {
		await authorizeIdentityOperation(this.sessions, context);
		assertIdentityTarget(userId, 1);
		try {
			const user = await this.prisma.user.findUnique({ where: { id: userId }, select: PROFILE });
			if (user === null) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
			return user;
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}

	async changeStatus(
		context: IdentityOperationContext,
		userId: string,
		expectedVersion: number,
		next: UserStatus,
	): Promise<void> {
		const actor = await authorizeIdentityOperation(this.sessions, context);
		assertIdentityTarget(userId, expectedVersion);
		try {
			await this.prisma.$transaction(async (transaction) => {
				const now = await lockIdentity(transaction, userId);
				const user = await transaction.user.findUnique({ where: { id: userId }, select: PROFILE });
				if (
					user?.identityVersion !== expectedVersion ||
					!canChangeAccountStatus(user.status, next, user.emailVerifiedAt)
				) {
					throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				}
				const updated = await transaction.user.updateMany({
					where: { id: userId, identityVersion: expectedVersion, status: user.status },
					data: { status: next, identityVersion: { increment: 1 } },
				});
				if (updated.count !== 1) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				await revokeIdentityAuthentication(transaction, userId, now);
				await recordIdentityEvent(transaction, actor, {
					userId,
					identityVersion: expectedVersion + 1,
					action:
						next === UserStatus.DISABLED
							? 'account_disabled'
							: next === UserStatus.SUSPENDED
								? 'account_suspended'
								: 'account_reactivated',
				});
			}, IDENTITY_TRANSACTION);
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}

	/** Transport remains future work. Only this short-lived internal result contains a raw proof. */
	async issueEmailVerification(
		context: IdentityOperationContext,
		userId: string,
		expectedVersion: number,
		targetEmail: string,
	): Promise<{ readonly token: string; readonly expiresAt: Date }> {
		await authorizeIdentityOperation(this.sessions, context);
		assertIdentityTarget(userId, expectedVersion);
		const target = email(targetEmail);
		const token = randomBytes(32).toString('base64url');
		const tokenDigest = proofDigest(token);
		if (tokenDigest === null) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const now = await lockIdentity(transaction, userId);
				const user = await transaction.user.findUnique({ where: { id: userId }, select: PROFILE });
				if (
					user?.identityVersion !== expectedVersion ||
					!accountCanProvisionCredentials(user.status) ||
					(user.email.toLowerCase() === target && user.emailVerifiedAt !== null)
				)
					throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				const expiresAt = new Date(now.getTime() + 15 * 60_000);
				await transaction.userEmailVerificationChallenge.updateMany({
					where: { userId, consumedAt: null },
					data: { consumedAt: now },
				});
				await transaction.userEmailVerificationChallenge.create({
					data: {
						userId,
						identityVersion: expectedVersion,
						targetEmail: target,
						tokenDigest,
						createdAt: now,
						expiresAt,
					},
				});
				return { token, expiresAt };
			}, IDENTITY_TRANSACTION);
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}

	/** Possession proves only the target mailbox. It grants no organization or platform assignment. */
	async consumeEmailVerification(token: string, requestId: string): Promise<void> {
		const tokenDigest = proofDigest(token);
		if (tokenDigest === null || !/^req_[0-9a-f-]{36}$/u.test(requestId))
			throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
		try {
			await this.prisma.$transaction(async (transaction) => {
				const challenge = await transaction.userEmailVerificationChallenge.findUnique({
					where: { tokenDigest },
				});
				if (challenge === null) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				const now = await lockIdentity(transaction, challenge.userId);
				const user = await transaction.user.findUnique({
					where: { id: challenge.userId },
					select: PROFILE,
				});
				if (
					user?.identityVersion !== challenge.identityVersion ||
					challenge.consumedAt !== null ||
					challenge.expiresAt <= now ||
					!accountCanProvisionCredentials(user.status)
				) {
					throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				}
				const consumed = await transaction.userEmailVerificationChallenge.updateMany({
					where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now } },
					data: { consumedAt: now },
				});
				if (consumed.count !== 1) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				// Revoke invitation-bound proofs while their old mailbox still matches its recipient.
				// Existing integrity triggers deliberately reject mismatched bound identities.
				await revokeIdentityAuthentication(transaction, user.id, now);
				const changedEmail = user.email.toLowerCase() !== challenge.targetEmail.toLowerCase();
				const changed = await transaction.user.updateMany({
					where: { id: user.id, identityVersion: challenge.identityVersion },
					data: {
						email: challenge.targetEmail,
						emailVerifiedAt: null,
						status: UserStatus.PENDING,
						identityVersion: { increment: 1 },
					},
				});
				if (changed.count !== 1) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				await transaction.user.update({
					where: { id: user.id },
					data: { emailVerifiedAt: now, status: UserStatus.ACTIVE },
				});
				const actor = { actorKind: 'email_verification' as const, actorUserId: user.id, requestId };
				if (changedEmail)
					await recordIdentityEvent(transaction, actor, {
						userId: user.id,
						action: 'email_changed',
						identityVersion: user.identityVersion + 1,
					});
				await recordIdentityEvent(transaction, actor, {
					userId: user.id,
					action: 'email_verified',
					identityVersion: user.identityVersion + 1,
				});
			}, IDENTITY_TRANSACTION);
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}
}
