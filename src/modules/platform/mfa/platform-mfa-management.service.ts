import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformStaffStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { effectivePlatformPermissions } from '../auth/platform-permission-policy.js';
import { PlatformPasswordService } from '../auth/platform-password.service.js';
import { PlatformSessionService } from '../auth/platform-session.service.js';
import { PlatformTokenService } from '../auth/platform-token.service.js';
import { PlatformTotpService } from '../auth/platform-totp.service.js';
import {
	recordPlatformAuthentication,
	type PlatformAuthenticationAction,
} from '../auth/platform-authentication-audit.js';
import { consumePlatformRecoveryCode } from '../auth/platform-recovery-code.js';
import {
	MFA_OPERATIONS,
	type MfaOperation,
	type PlatformStepUpStartDto,
	type PlatformStepUpVerifyDto,
	type PlatformMfaFactorDto,
} from './platform-mfa-management.dto.js';

const SESSION_INCLUDE = {
	platformStaff: {
		include: {
			user: { include: { passwordCredential: true } },
			totpCredential: true,
			roles: {
				include: {
					platformRole: { include: { permissions: { include: { platformPermission: true } } } },
				},
			},
		},
	},
} as const;
type SecuritySession = Prisma.PlatformAdminSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;
type Proof = Prisma.PlatformMfaChallengeGetPayload<Record<string, never>>;
type NotificationEvent =
	| 'mfa_factor_enrolled'
	| 'mfa_factor_replaced'
	| 'mfa_factor_renamed'
	| 'mfa_recovery_rotated'
	| 'mfa_recovery_used';
const OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 5000,
	timeout: 10_000,
} as const;
const LIFETIME = 300_000;
const MAX_ATTEMPTS = 5;

/** One TOTP slot per staff identity. Every mutation locks the identity before its staff/security rows. */
@Injectable()
export class PlatformMfaManagementService {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly sessions: PlatformSessionService,
		private readonly passwords: PlatformPasswordService,
		private readonly tokens: PlatformTokenService,
		private readonly totp: PlatformTotpService,
	) {}

	async list(sessionToken: string): Promise<PlatformMfaFactorDto[]> {
		this.assertEnabled();
		const principal = await this.sessions.authenticateForMfaManagement(sessionToken);
		try {
			const factor = await this.prisma.platformTotpCredential.findUnique({
				where: { platformStaffId: principal.platformStaffId },
				select: {
					id: true,
					label: true,
					verifiedAt: true,
					disabledAt: true,
					createdAt: true,
					lastUsedAt: true,
				},
			});
			return factor === null
				? []
				: [
						{
							id: factor.id,
							type: 'totp',
							label: factor.label,
							status:
								factor.disabledAt !== null
									? 'revoked'
									: factor.verifiedAt === null
										? 'pending'
										: 'active',
							createdAt: factor.createdAt.toISOString(),
							lastUsedAt: factor.lastUsedAt?.toISOString() ?? null,
						},
					];
		} catch (error: unknown) {
			throw this.failure(error);
		}
	}

	async start(
		sessionToken: string,
		input: PlatformStepUpStartDto,
		requestId: string,
	): Promise<{ token: string; expiresAt: Date; verified: boolean }> {
		this.assertEnabled();
		if (!MFA_OPERATIONS.includes(input.operation))
			throw new ApiProblemException('VALIDATION_FAILED');
		const principal = await this.sessions.authenticateForMfaManagement(sessionToken);
		const identity = await this.prisma.user
			.findUnique({
				where: { id: principal.userId },
				select: { passwordCredential: true },
			})
			.catch((error: unknown) => {
				throw this.failure(error);
			});
		const credential = identity?.passwordCredential;
		const valid = await this.passwords.verify(
			credential?.passwordHash ?? this.passwords.dummyHash,
			input.password,
			credential?.normalization ?? 'raw',
		);
		if (!valid || credential?.disabledAt !== null)
			throw new ApiProblemException('AUTH_REAUTHENTICATION_REQUIRED');
		return this.transaction(sessionToken, async (transaction, session, now) => {
			this.allowOperation(session, input.operation);
			if (
				session.platformStaff.user.passwordCredential?.passwordHash !== credential.passwordHash ||
				session.platformStaff.user.passwordCredential.version !== credential.version
			)
				throw new ApiProblemException('AUTH_REAUTHENTICATION_REQUIRED');
			this.target(session, input.operation, input.factorId);
			await transaction.platformMfaChallenge.updateMany({
				where: {
					platformStaffId: session.platformStaffId,
					purpose: { not: 'login' },
					consumedAt: null,
				},
				data: { consumedAt: now },
			});
			const token = this.tokens.createToken();
			const expiresAt = new Date(Math.min(session.expiresAt.getTime(), now.getTime() + LIFETIME));
			// A recovery code was just consumed at login. Fresh password verification narrows that
			// short-lived session to one repair action without requiring a second unused code.
			const verified =
				session.authenticationMethod === 'recovery_code' &&
				session.mfaVerifiedAt.getTime() >= now.getTime() - LIFETIME;
			await transaction.platformMfaChallenge.create({
				data: {
					platformStaffId: session.platformStaffId,
					platformSessionId: session.id,
					purpose: 'step_up',
					operation: input.operation,
					tokenDigest: this.tokens.digest(token),
					mfaVersion: session.platformStaff.mfaVersion,
					identityVersion: session.platformStaff.user.identityVersion,
					credentialVersion: credential.version,
					factorVersion: session.platformStaff.totpCredential?.version ?? 0,
					factorId: input.factorId ?? null,
					createdAt: now,
					expiresAt,
					maxAttempts: MAX_ATTEMPTS,
					verifiedAt: verified ? now : null,
				},
			});
			await this.audit(transaction, session, 'mfa_step_up_started', requestId);
			if (verified) await this.audit(transaction, session, 'mfa_step_up_verified', requestId);
			return { token, expiresAt, verified };
		});
	}

	async verify(
		sessionToken: string,
		token: string,
		input: PlatformStepUpVerifyDto,
		requestId: string,
	): Promise<void> {
		const accepted = await this.transaction(sessionToken, async (transaction, session, now) => {
			const proof = await this.proof(transaction, session, token, 'step_up', now);
			if (proof.verifiedAt !== null) throw new ApiProblemException('AUTH_MFA_INVALID');
			this.allowOperation(session, this.operation(proof));
			let valid = false;
			if (input.method === 'totp') {
				const factor = session.platformStaff.totpCredential;
				if (
					factor !== null &&
					factor.verifiedAt !== null &&
					factor.disabledAt === null &&
					/^\d{6}$/u.test(input.code)
				) {
					const step = this.totp.verify(factor, input.code, now);
					if (step !== null) {
						const updated = await transaction.platformTotpCredential.updateMany({
							where: {
								id: factor.id,
								platformStaffId: session.platformStaffId,
								version: factor.version,
								disabledAt: null,
								verifiedAt: { not: null },
								OR: [
									{ lastAcceptedTimeStep: null },
									{ lastAcceptedTimeStep: { lt: step.timeStep } },
								],
							},
							data: { lastAcceptedTimeStep: step.timeStep, lastUsedAt: now },
						});
						valid = updated.count === 1;
					}
				}
			} else if (['totp_enroll', 'totp_replace'].includes(this.operation(proof))) {
				valid = await consumePlatformRecoveryCode(
					transaction,
					this.tokens,
					session.platformStaffId,
					session.platformStaff.recoveryGeneration,
					input.code,
					now,
				);
				if (valid) {
					await transaction.platformAdminSession.updateMany({
						where: {
							platformStaffId: session.platformStaffId,
							id: { not: session.id },
							revokedAt: null,
						},
						data: { revokedAt: now, revocationReason: 'recovery_used' },
					});
					await transaction.platformMfaChallenge.updateMany({
						where: {
							platformStaffId: session.platformStaffId,
							id: { not: proof.id },
							consumedAt: null,
						},
						data: { consumedAt: now },
					});
					await this.audit(transaction, session, 'mfa_recovery_used', requestId);
					await this.notify(transaction, session, 'mfa_recovery_used', requestId);
				}
			}
			if (!valid) {
				await this.failed(transaction, session, proof, requestId);
				return false;
			}
			const changed = await transaction.platformMfaChallenge.updateMany({
				where: {
					id: proof.id,
					consumedAt: null,
					verifiedAt: null,
					failedAttempts: { lt: MAX_ATTEMPTS },
					expiresAt: { gt: now },
				},
				data: { verifiedAt: now },
			});
			if (changed.count !== 1) throw new ApiProblemException('AUTH_MFA_INVALID');
			await this.audit(transaction, session, 'mfa_step_up_verified', requestId);
			return true;
		});
		if (!accepted) throw new ApiProblemException('AUTH_MFA_INVALID');
	}

	async enroll(
		sessionToken: string,
		token: string,
		label: string,
		factorId: string | undefined,
		requestId: string,
	): Promise<{ token: string; expiresAt: Date; secret: string; enrollmentUri: string }> {
		const safeLabel = this.label(label);
		return this.transaction(sessionToken, async (transaction, session, now) => {
			const operation = factorId === undefined ? 'totp_enroll' : 'totp_replace';
			const proof = await this.proof(
				transaction,
				session,
				token,
				'step_up',
				now,
				operation,
				factorId,
			);
			this.target(session, operation, factorId);
			await this.consume(transaction, proof, now);
			const enrollment = this.totp.createEnrollment(
				session.platformStaffId,
				session.platformStaff.user.email,
			);
			const nextToken = this.tokens.createToken();
			await transaction.platformMfaChallenge.create({
				data: {
					platformStaffId: session.platformStaffId,
					platformSessionId: session.id,
					purpose: 'enrollment',
					operation,
					tokenDigest: this.tokens.digest(nextToken),
					mfaVersion: proof.mfaVersion,
					identityVersion: proof.identityVersion,
					credentialVersion: proof.credentialVersion,
					factorVersion: proof.factorVersion,
					factorId: proof.factorId,
					createdAt: now,
					expiresAt: proof.expiresAt,
					label: safeLabel,
					encryptedSecret: Buffer.from(enrollment.encryptedSecret),
					encryptionKeyId: enrollment.encryptionKeyId,
					encryptionVersion: enrollment.encryptionVersion,
					initializationVector: Buffer.from(enrollment.initializationVector),
					authenticationTag: Buffer.from(enrollment.authenticationTag),
					maxAttempts: MAX_ATTEMPTS,
				},
			});
			await this.audit(transaction, session, 'mfa_enrollment_started', requestId);
			return {
				token: nextToken,
				expiresAt: proof.expiresAt,
				secret: enrollment.secret,
				enrollmentUri: enrollment.enrollmentUri,
			};
		});
	}

	async confirm(
		sessionToken: string,
		token: string,
		code: string,
		factorId: string | undefined,
		requestId: string,
	): Promise<string[]> {
		const result = await this.transaction(sessionToken, async (transaction, session, now) => {
			const operation = factorId === undefined ? 'totp_enroll' : 'totp_replace';
			const proof = await this.proof(
				transaction,
				session,
				token,
				'enrollment',
				now,
				operation,
				factorId,
			);
			this.target(session, operation, factorId);
			if (
				proof.encryptedSecret === null ||
				proof.initializationVector === null ||
				proof.authenticationTag === null ||
				proof.encryptionKeyId === null ||
				proof.encryptionVersion === null ||
				proof.label === null
			)
				throw new ApiProblemException('AUTH_MFA_INVALID');
			const step = /^\d{6}$/u.test(code)
				? this.totp.verify(
						{
							platformStaffId: session.platformStaffId,
							encryptedSecret: proof.encryptedSecret,
							initializationVector: proof.initializationVector,
							authenticationTag: proof.authenticationTag,
							encryptionKeyId: proof.encryptionKeyId,
							encryptionVersion: proof.encryptionVersion,
						},
						code,
						now,
					)
				: null;
			if (step === null) {
				await this.failed(transaction, session, proof, requestId);
				return null;
			}
			await this.consume(transaction, proof, now);
			const data = {
				label: proof.label,
				encryptedSecret: Buffer.from(proof.encryptedSecret),
				initializationVector: Buffer.from(proof.initializationVector),
				authenticationTag: Buffer.from(proof.authenticationTag),
				encryptionKeyId: proof.encryptionKeyId,
				encryptionVersion: proof.encryptionVersion,
				verifiedAt: now,
				disabledAt: null,
				lastAcceptedTimeStep: step.timeStep,
				lastUsedAt: now,
			};
			const existing = session.platformStaff.totpCredential;
			if (existing === null) {
				await transaction.platformTotpCredential.create({
					data: { ...data, platformStaffId: session.platformStaffId },
				});
			} else {
				const changed = await transaction.platformTotpCredential.updateMany({
					where: {
						id: existing.id,
						platformStaffId: session.platformStaffId,
						version: existing.version,
					},
					data,
				});
				if (changed.count !== 1) throw new ApiProblemException('AUTH_MFA_INVALID');
			}
			// The reviewed DB trigger advances the MFA generation and revokes every old session/proof.
			const staff = await transaction.platformStaff.findUniqueOrThrow({
				where: { id: session.platformStaffId },
			});
			const codes = await this.codes(
				transaction,
				session.platformStaffId,
				staff.recoveryGeneration,
				now,
			);
			const event = operation === 'totp_enroll' ? 'mfa_factor_enrolled' : 'mfa_factor_replaced';
			await this.audit(transaction, session, event, requestId);
			await this.audit(transaction, session, 'mfa_recovery_rotated', requestId);
			await this.notify(transaction, session, event, requestId);
			return codes;
		});
		if (result === null) throw new ApiProblemException('AUTH_MFA_INVALID');
		return result;
	}

	async rename(
		sessionToken: string,
		token: string,
		factorId: string,
		label: string,
		requestId: string,
	): Promise<void> {
		const safeLabel = this.label(label);
		await this.transaction(sessionToken, async (transaction, session, now) => {
			const proof = await this.proof(
				transaction,
				session,
				token,
				'step_up',
				now,
				'factor_rename',
				factorId,
			);
			this.target(session, 'factor_rename', factorId);
			await this.consume(transaction, proof, now);
			await transaction.platformTotpCredential.update({
				where: { platformStaffId: session.platformStaffId },
				data: { label: safeLabel },
			});
			await this.audit(transaction, session, 'mfa_factor_renamed', requestId);
			await this.notify(transaction, session, 'mfa_factor_renamed', requestId);
		});
	}

	async remove(
		sessionToken: string,
		token: string,
		factorId: string,
		requestId: string,
	): Promise<never> {
		await this.transaction(sessionToken, async (transaction, session, now) => {
			const proof = await this.proof(
				transaction,
				session,
				token,
				'step_up',
				now,
				'totp_remove',
				factorId,
			);
			this.target(session, 'totp_remove', factorId);
			await this.consume(transaction, proof, now);
			await this.audit(transaction, session, 'mfa_factor_change_denied', requestId);
		});
		throw new ApiProblemException('AUTH_MFA_FACTOR_CHANGE_DENIED');
	}

	async regenerate(sessionToken: string, token: string, requestId: string): Promise<string[]> {
		return this.transaction(sessionToken, async (transaction, session, now) => {
			const proof = await this.proof(
				transaction,
				session,
				token,
				'step_up',
				now,
				'recovery_regenerate',
			);
			await this.consume(transaction, proof, now);
			const staff = await transaction.platformStaff.update({
				where: { id: session.platformStaffId },
				data: { mfaVersion: { increment: 1 }, recoveryGeneration: { increment: 1 } },
			});
			await transaction.platformAdminSession.updateMany({
				where: { platformStaffId: staff.id, revokedAt: null },
				data: { revokedAt: now, revocationReason: 'recovery_rotated' },
			});
			await transaction.platformMfaChallenge.updateMany({
				where: { platformStaffId: staff.id, consumedAt: null },
				data: { consumedAt: now },
			});
			const codes = await this.codes(transaction, staff.id, staff.recoveryGeneration, now);
			await this.audit(transaction, session, 'mfa_recovery_rotated', requestId);
			await this.notify(transaction, session, 'mfa_recovery_rotated', requestId);
			return codes;
		});
	}

	private async transaction<T>(
		token: string,
		operation: (tx: Prisma.TransactionClient, session: SecuritySession, now: Date) => Promise<T>,
	): Promise<T> {
		this.assertEnabled();
		const principal = await this.sessions.authenticateForMfaManagement(token);
		try {
			return await this.prisma.$transaction(async (transaction) => {
				await transaction.$queryRaw`SELECT id FROM public.users WHERE id = ${principal.userId}::uuid FOR UPDATE`;
				await transaction.$queryRaw`SELECT id FROM public.platform_staff WHERE id = ${principal.platformStaffId}::uuid FOR UPDATE`;
				const [clock] = await transaction.$queryRaw<
					{ now: Date }[]
				>`SELECT clock_timestamp() AS now`;
				if (clock === undefined) throw new ApiProblemException('SERVICE_UNAVAILABLE');
				const now = clock.now;
				const session = await transaction.platformAdminSession.findUnique({
					where: { tokenDigest: this.tokens.digest(token) },
					include: SESSION_INCLUDE,
				});
				if (
					session?.id !== principal.sessionId ||
					session.platformStaffId !== principal.platformStaffId ||
					session.platformStaff.user.id !== principal.userId ||
					session.revokedAt !== null ||
					session.expiresAt <= now ||
					session.idleExpiresAt <= now ||
					session.mfaVerifiedAt > now ||
					session.mfaVersion !== session.platformStaff.mfaVersion ||
					session.platformStaff.status !== PlatformStaffStatus.ACTIVE ||
					!accountCanAuthenticate(
						session.platformStaff.user.status,
						session.platformStaff.user.emailVerifiedAt,
					) ||
					session.platformStaff.user.passwordCredential?.disabledAt !== null ||
					session.platformStaff.user.passwordCredential.passwordChangedAt > session.createdAt ||
					!['totp', 'recovery_code'].includes(session.authenticationMethod) ||
					effectivePlatformPermissions(session.platformStaff.roles).length === 0
				)
					throw new ApiProblemException('UNAUTHENTICATED');
				return operation(transaction, session, now);
			}, OPTIONS);
		} catch (error: unknown) {
			throw this.failure(error);
		}
	}

	private async proof(
		tx: Prisma.TransactionClient,
		session: SecuritySession,
		token: string,
		purpose: string,
		now: Date,
		operation?: MfaOperation,
		factorId?: string,
	): Promise<Proof> {
		if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
			throw new ApiProblemException('AUTH_REAUTHENTICATION_REQUIRED');
		const proof = await tx.platformMfaChallenge.findUnique({
			where: { tokenDigest: this.tokens.digest(token) },
		});
		if (
			proof?.purpose !== purpose ||
			proof.platformStaffId !== session.platformStaffId ||
			proof.platformSessionId !== session.id ||
			proof.consumedAt !== null ||
			proof.expiresAt <= now ||
			proof.createdAt > now ||
			(proof.verifiedAt !== null && proof.verifiedAt > now) ||
			proof.failedAttempts >= proof.maxAttempts ||
			proof.mfaVersion !== session.platformStaff.mfaVersion ||
			proof.identityVersion !== session.platformStaff.user.identityVersion ||
			proof.credentialVersion !== session.platformStaff.user.passwordCredential?.version ||
			proof.factorVersion !== (session.platformStaff.totpCredential?.version ?? 0) ||
			(operation !== undefined &&
				(proof.operation !== operation || proof.factorId !== (factorId ?? null))) ||
			(operation !== undefined && purpose === 'step_up' && proof.verifiedAt === null)
		)
			throw new ApiProblemException('AUTH_REAUTHENTICATION_REQUIRED');
		this.allowOperation(session, this.operation(proof));
		return proof;
	}

	private operation(proof: Proof): MfaOperation {
		const operation = MFA_OPERATIONS.find((candidate) => candidate === proof.operation);
		if (operation === undefined) throw new ApiProblemException('AUTH_MFA_INVALID');
		return operation;
	}

	private allowOperation(session: SecuritySession, operation: MfaOperation): void {
		if (
			session.authenticationMethod === 'recovery_code' &&
			!['totp_enroll', 'totp_replace'].includes(operation)
		)
			throw new ApiProblemException('ACCESS_DENIED');
	}

	private target(session: SecuritySession, operation: MfaOperation, factorId?: string): void {
		const factor = session.platformStaff.totpCredential;
		const active = factor !== null && factor.verifiedAt !== null && factor.disabledAt === null;
		if (operation === 'totp_enroll' || operation === 'recovery_regenerate') {
			if (factorId !== undefined || (operation === 'totp_enroll' && active))
				throw new ApiProblemException('AUTH_MFA_FACTOR_CHANGE_DENIED');
		} else if (factor === null || !active || factor.id !== factorId)
			throw new ApiProblemException('AUTH_MFA_FACTOR_NOT_FOUND');
	}

	private async consume(tx: Prisma.TransactionClient, proof: Proof, now: Date): Promise<void> {
		const changed = await tx.platformMfaChallenge.updateMany({
			where: {
				id: proof.id,
				consumedAt: null,
				expiresAt: { gt: now },
				failedAttempts: { lt: proof.maxAttempts },
			},
			data: { consumedAt: now },
		});
		if (changed.count !== 1) throw new ApiProblemException('AUTH_MFA_INVALID');
	}

	private async failed(
		tx: Prisma.TransactionClient,
		session: SecuritySession,
		proof: Proof,
		requestId: string,
	): Promise<void> {
		await tx.platformMfaChallenge.updateMany({
			where: { id: proof.id, consumedAt: null, failedAttempts: { lt: proof.maxAttempts } },
			data: { failedAttempts: { increment: 1 } },
		});
		await this.audit(
			tx,
			session,
			proof.purpose === 'enrollment' ? 'mfa_enrollment_failed' : 'platform_mfa_rejected',
			requestId,
		);
	}

	private async codes(
		tx: Prisma.TransactionClient,
		staffId: string,
		generation: number,
		now: Date,
	): Promise<string[]> {
		await tx.platformRecoveryCode.updateMany({
			where: { platformStaffId: staffId, usedAt: null },
			data: { usedAt: now },
		});
		const codes = this.tokens.createRecoveryCodes();
		await tx.platformRecoveryCode.createMany({
			data: codes.map((code) => ({
				platformStaffId: staffId,
				generation,
				digestVersion: 2,
				codeDigest: this.tokens.recoveryCodeDigest(code),
				createdAt: now,
			})),
		});
		return codes;
	}

	private audit(
		tx: Prisma.TransactionClient,
		session: SecuritySession,
		action: PlatformAuthenticationAction,
		requestId: string,
	): Promise<void> {
		return recordPlatformAuthentication(tx, session.platformStaff.user, action, requestId);
	}

	private async notify(
		tx: Prisma.TransactionClient,
		session: SecuritySession,
		event: NotificationEvent,
		requestId: string,
	): Promise<void> {
		await tx.platformSecurityNotification.create({
			data: {
				platformStaffId: session.platformStaffId,
				recipient: session.platformStaff.user.email,
				event,
				requestId: /^req_[0-9a-f-]{36}$/u.test(requestId) ? requestId : `req_${randomUUID()}`,
			},
		});
	}

	private label(value: string): string {
		if (/[\p{Cc}\p{Cs}]/u.test(value) || value.trim().length < 1 || value.trim().length > 80)
			throw new ApiProblemException('VALIDATION_FAILED');
		return value.trim();
	}

	private assertEnabled(): void {
		if (!this.config.get('PLATFORM_MFA_MANAGEMENT_ENABLED', { infer: true }))
			throw new ApiProblemException('SERVICE_UNAVAILABLE');
	}

	private failure(error: unknown): ApiProblemException {
		return error instanceof ApiProblemException
			? error
			: new ApiProblemException('SERVICE_UNAVAILABLE', [], error);
	}
}
