import { Injectable } from '@nestjs/common';
import { PrismaService, type User } from '@nexcoderw/akiba-db';

import { accountCanProvisionCredentials } from '../../common/identity/account-state.policy.js';
import { acceptsPasswordCreation } from '../../common/identity/password-policy.js';
import { ApiProblemException } from '../../common/errors/api-problem.exception.js';
import { PlatformPasswordService } from '../platform/auth/platform-password.service.js';
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

export interface CredentialTarget {
	readonly userId: string;
	readonly identityVersion: number;
	/** Null permits initial setup only, never an upsert over an existing credential. */
	readonly credentialVersion: number | null;
}

/** Explicit administrative foundation; no arbitrary user ID is sufficient authority.
 * Hashing occurs outside transactions. Identity and credential versions prevent lost updates.
 */
@Injectable()
export class PasswordCredentialService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly sessions: PlatformSessionService,
		private readonly passwords: PlatformPasswordService,
	) {}

	async setPassword(
		context: IdentityOperationContext,
		target: CredentialTarget,
		password: Buffer,
	): Promise<void> {
		const actor = await authorizeIdentityOperation(this.sessions, context);
		const { userId, identityVersion, credentialVersion } = target;
		assertIdentityTarget(userId, identityVersion);
		if (
			credentialVersion !== null &&
			(!Number.isSafeInteger(credentialVersion) || credentialVersion < 1)
		) {
			throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
		}
		// The preliminary lookup supplies context-specific blocklist input, never authority.
		let user: Pick<User, 'email' | 'status'> | null;
		try {
			user = await this.prisma.user.findUnique({
				where: { id: userId },
				select: { email: true, status: true },
			});
		} catch (error: unknown) {
			throw identityFailure(error);
		}
		if (user === null || !accountCanProvisionCredentials(user.status))
			throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
		if (!acceptsPasswordCreation(password, user.email))
			throw new ApiProblemException('PASSWORD_POLICY_VIOLATION');
		const passwordHash = await this.passwords.hash(password);
		try {
			await this.prisma.$transaction(async (transaction) => {
				const databaseNow = await lockIdentity(transaction, userId);
				const current = await transaction.user.findUnique({
					where: { id: userId },
					select: {
						identityVersion: true,
						status: true,
						passwordCredential: true,
					},
				});
				if (
					current?.identityVersion !== identityVersion ||
					!accountCanProvisionCredentials(current.status) ||
					(current.passwordCredential?.version ?? null) !== credentialVersion
				)
					throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				const now = new Date(
					Math.max(
						databaseNow.getTime(),
						(current.passwordCredential?.passwordChangedAt.getTime() ?? 0) + 1,
					),
				);
				const version = (credentialVersion ?? 0) + 1;
				const identity = await transaction.user.updateMany({
					where: { id: userId, identityVersion },
					data: { identityVersion: { increment: 1 } },
				});
				if (identity.count !== 1) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				if (credentialVersion === null) {
					await transaction.passwordCredential.create({
						data: { userId, passwordHash, normalization: 'nfc', passwordChangedAt: now },
					});
				} else {
					const changed = await transaction.passwordCredential.updateMany({
						where: { userId, version: credentialVersion },
						data: {
							passwordHash,
							normalization: 'nfc',
							passwordChangedAt: now,
							version,
							disabledAt: null,
						},
					});
					if (changed.count !== 1) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				}
				await revokeIdentityAuthentication(transaction, userId, now);
				await recordIdentityEvent(transaction, actor, {
					userId,
					identityVersion: identityVersion + 1,
					credentialVersion: version,
					action: credentialVersion === null ? 'password_created' : 'password_changed',
				});
			}, IDENTITY_TRANSACTION);
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}

	async disable(
		context: IdentityOperationContext,
		target: CredentialTarget,
		reason: 'disabled' | 'compromised',
	): Promise<void> {
		const actor = await authorizeIdentityOperation(this.sessions, context);
		const { userId, identityVersion, credentialVersion } = target;
		assertIdentityTarget(userId, identityVersion);
		if (
			credentialVersion === null ||
			!Number.isSafeInteger(credentialVersion) ||
			credentialVersion < 1
		) {
			throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
		}
		try {
			await this.prisma.$transaction(async (transaction) => {
				const now = await lockIdentity(transaction, userId);
				const user = await transaction.user.updateMany({
					where: { id: userId, identityVersion },
					data: { identityVersion: { increment: 1 } },
				});
				const credential = await transaction.passwordCredential.updateMany({
					where: { userId, version: credentialVersion, disabledAt: null },
					data: { disabledAt: now, version: { increment: 1 } },
				});
				if (user.count !== 1 || credential.count !== 1)
					throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				await revokeIdentityAuthentication(transaction, userId, now);
				await recordIdentityEvent(transaction, actor, {
					userId,
					identityVersion: identityVersion + 1,
					credentialVersion: credentialVersion + 1,
					action: reason === 'compromised' ? 'credential_compromised' : 'credential_disabled',
				});
			}, IDENTITY_TRANSACTION);
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}

	/** Verification is mandatory before an upgrade; it never changes the password-change timestamp. */
	async upgradeHash(
		context: IdentityOperationContext,
		target: CredentialTarget,
		password: Buffer,
	): Promise<boolean> {
		const actor = await authorizeIdentityOperation(this.sessions, context);
		const { userId, identityVersion, credentialVersion } = target;
		assertIdentityTarget(userId, identityVersion);
		try {
			const credential = await this.prisma.passwordCredential.findUnique({ where: { userId } });
			if (
				credential?.disabledAt !== null ||
				credential.version !== credentialVersion ||
				!(await this.passwords.verify(
					credential.passwordHash,
					password.toString('utf8'),
					credential.normalization,
				))
			) {
				throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
			}
			if (!this.passwords.needsRehash(credential.passwordHash, credential.normalization))
				return false;
			const passwordHash = await this.passwords.hashForUpgrade(
				password,
				credential.passwordHash,
				credential.normalization,
			);
			await this.prisma.$transaction(async (transaction) => {
				await lockIdentity(transaction, userId);
				const user = await transaction.user.findUnique({
					where: { id: userId },
					select: { status: true, identityVersion: true },
				});
				if (
					user?.identityVersion !== identityVersion ||
					!accountCanProvisionCredentials(user.status)
				) {
					throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				}
				const changed = await transaction.passwordCredential.updateMany({
					where: {
						userId,
						version: credential.version,
						passwordHash: credential.passwordHash,
						disabledAt: null,
					},
					data: { passwordHash, version: { increment: 1 } },
				});
				if (changed.count !== 1) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
				await recordIdentityEvent(transaction, actor, {
					userId,
					identityVersion,
					credentialVersion: credential.version + 1,
					action: 'password_rehashed',
				});
			}, IDENTITY_TRANSACTION);
			return true;
		} catch (error: unknown) {
			throw identityFailure(error);
		}
	}
}
