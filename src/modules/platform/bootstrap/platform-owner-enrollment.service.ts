import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	PlatformStaffStatus,
	Prisma,
	PrismaService,
	UserStatus,
	type PlatformOwnerEnrollment,
} from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import {
	acceptsPasswordCreation,
	MINIMUM_MFA_PASSWORD_CHARACTERS,
} from '../../../common/identity/password-policy.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { ResendEmailService } from '../../../infrastructure/email/resend-email.service.js';
import { recordIdentityEvent } from '../../identity/identity-security.js';
import { recordPlatformAuthentication } from '../auth/platform-authentication-audit.js';
import { PlatformPasswordService } from '../auth/platform-password.service.js';
import { PlatformTokenService } from '../auth/platform-token.service.js';
import { PlatformTotpService } from '../auth/platform-totp.service.js';
import { acquireBootstrapLock } from './platform-bootstrap-database.js';

const LIFETIME_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 3;
const MAX_SETUPS = 3;

/** Mailbox possession authorizes setup only for the operator-reserved, sole pending system owner.
 * No operation issues an admin session or repairs an active identity. All mutations share the
 * bootstrap advisory lock; serializable transactions keep concurrent exchange/activation single-use.
 */
@Injectable()
export class PlatformOwnerEnrollmentService {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly tokens: PlatformTokenService,
		private readonly passwords: PlatformPasswordService,
		private readonly totp: PlatformTotpService,
		private readonly email: ResendEmailService,
	) {}

	/** Operator-only explicit delivery. An uncertain provider response is never retried automatically. */
	async send(): Promise<void> {
		if (
			this.config.get('RESEND_API_KEY', { infer: true }) === null ||
			this.config.get('RESEND_FROM_EMAIL', { infer: true }) === null
		) {
			throw new ApiProblemException('PLATFORM_EMAIL_UNAVAILABLE');
		}
		const token = this.tokens.createToken();
		const delivery = await this.transaction(async (tx, now) => {
			const staff = await this.pendingOwner(tx);
			const previous = await tx.platformOwnerEnrollment.findUnique({
				where: { platformStaffId: staff.id },
			});
			if (
				previous !== null &&
				(previous.sendCount >= MAX_SENDS || now.getTime() - previous.createdAt.getTime() < 60_000)
			) {
				throw new ApiProblemException('RATE_LIMITED');
			}
			const data = {
				email: staff.user.email,
				identityVersion: staff.user.identityVersion,
				tokenDigest: this.digest('mailbox', token),
				createdAt: now,
				expiresAt: new Date(now.getTime() + LIFETIME_MS),
				sentAt: null,
				exchangedAt: null,
				consumedAt: null,
				sessionDigest: null,
				sendCount: (previous?.sendCount ?? 0) + 1,
				failedAttempts: 0,
				setupVersion: 0,
				passwordHash: null,
				encryptedSecret: null,
				encryptionKeyId: null,
				encryptionVersion: null,
				initializationVector: null,
				authenticationTag: null,
			};
			const row = await tx.platformOwnerEnrollment.upsert({
				where: { platformStaffId: staff.id },
				create: { platformStaffId: staff.id, ...data },
				update: data,
			});
			return { id: row.id, email: row.email, tokenDigest: row.tokenDigest };
		});
		await this.email.sendOwnerEnrollment(
			delivery.email,
			token,
			`${delivery.id}/${delivery.tokenDigest}`,
		);
		// Delivery acknowledgement is conditional: an older send cannot activate a newer proof.
		const sent = await this.transaction((tx, now) =>
			tx.platformOwnerEnrollment.updateMany({
				where: { id: delivery.id, tokenDigest: delivery.tokenDigest, consumedAt: null },
				data: { sentAt: now },
			}),
		);
		if (sent.count !== 1) throw new ApiProblemException('AUTH_MFA_INVALID');
	}

	async exchange(token: string): Promise<{ stage: 'password'; expiresAt: string; token: string }> {
		if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalid();
		const sessionToken = this.tokens.createToken();
		return this.transaction(async (tx, now) => {
			const staff = await this.pendingOwner(tx);
			const row = await tx.platformOwnerEnrollment.findUnique({
				where: { tokenDigest: this.digest('mailbox', token) },
			});
			if (
				row?.platformStaffId !== staff.id ||
				row.sentAt === null ||
				row.exchangedAt !== null ||
				!this.usable(row, staff.user, now)
			)
				throw invalid();
			const expiresAt = new Date(Math.min(row.expiresAt.getTime(), now.getTime() + LIFETIME_MS));
			await tx.platformOwnerEnrollment.update({
				where: { id: row.id },
				data: { sessionDigest: this.digest('session', sessionToken), exchangedAt: now, expiresAt },
			});
			return {
				stage: 'password' as const,
				expiresAt: expiresAt.toISOString(),
				token: sessionToken,
			};
		});
	}

	async status(token: string): Promise<{ stage: 'password' | 'mfa'; expiresAt: string }> {
		return this.withProof(token, (_tx, row) => ({
			stage: row.passwordHash === null ? ('password' as const) : ('mfa' as const),
			expiresAt: row.expiresAt.toISOString(),
		}));
	}

	async password(
		token: string,
		value: string,
		requestId: string,
	): Promise<{ stage: 'mfa'; expiresAt: string }> {
		// Prove eligibility before spending bounded Argon2 work; recheck under lock after hashing.
		const progress = await this.status(token);
		if (progress.stage !== 'password') throw new ApiProblemException('RESOURCE_CONFLICT');
		const buffer = Buffer.from(value, 'utf8');
		let passwordHash: string;
		try {
			passwordHash = await this.passwords.hashForMfaEnrollment(buffer);
		} finally {
			buffer.fill(0);
		}
		return this.withProof(token, async (tx, row, staff) => {
			const candidate = Buffer.from(value, 'utf8');
			try {
				if (!acceptsPasswordCreation(candidate, staff.user.email, MINIMUM_MFA_PASSWORD_CHARACTERS))
					throw new ApiProblemException('PASSWORD_POLICY_VIOLATION');
			} finally {
				candidate.fill(0);
			}
			if (row.passwordHash !== null) throw new ApiProblemException('RESOURCE_CONFLICT');
			await tx.platformOwnerEnrollment.update({ where: { id: row.id }, data: { passwordHash } });
			await recordPlatformAuthentication(tx, staff.user, 'mfa_enrollment_started', requestId);
			return { stage: 'mfa' as const, expiresAt: row.expiresAt.toISOString() };
		});
	}

	async setup(token: string): Promise<{ secret: string; version: number }> {
		return this.withProof(token, async (tx, row, staff) => {
			if (row.passwordHash === null || row.setupVersion >= MAX_SETUPS) throw invalid();
			const enrollment = this.totp.createEnrollment(staff.id, staff.user.email);
			const version = row.setupVersion + 1;
			await tx.platformOwnerEnrollment.update({
				where: { id: row.id },
				data: {
					setupVersion: version,
					encryptedSecret: Buffer.from(enrollment.encryptedSecret),
					encryptionKeyId: enrollment.encryptionKeyId,
					encryptionVersion: enrollment.encryptionVersion,
					initializationVector: Buffer.from(enrollment.initializationVector),
					authenticationTag: Buffer.from(enrollment.authenticationTag),
				},
			});
			return { secret: enrollment.secret, version };
		});
	}

	async complete(
		token: string,
		code: string,
		version: number,
		requestId: string,
	): Promise<{ recoveryCodes: string[] }> {
		const result = await this.withProof(token, async (tx, row, staff, now) => {
			if (
				row.passwordHash === null ||
				row.encryptedSecret === null ||
				row.initializationVector === null ||
				row.authenticationTag === null ||
				row.encryptionKeyId === null ||
				row.encryptionVersion === null ||
				row.setupVersion !== version
			)
				throw invalid();
			const step = /^\d{6}$/u.test(code)
				? this.totp.verify(
						{
							platformStaffId: staff.id,
							encryptedSecret: row.encryptedSecret,
							initializationVector: row.initializationVector,
							authenticationTag: row.authenticationTag,
							encryptionKeyId: row.encryptionKeyId,
							encryptionVersion: row.encryptionVersion,
						},
						code,
						now,
					)
				: null;
			if (step === null) {
				await tx.platformOwnerEnrollment.update({
					where: { id: row.id },
					data: { failedAttempts: { increment: 1 } },
				});
				await recordPlatformAuthentication(tx, staff.user, 'mfa_enrollment_failed', requestId);
				return null; // Commit the attempt before returning a generic public rejection.
			}
			await tx.platformOwnerEnrollment.update({
				where: { id: row.id },
				data: {
					consumedAt: now,
					passwordHash: null,
					setupVersion: 0,
					encryptedSecret: null,
					encryptionKeyId: null,
					encryptionVersion: null,
					initializationVector: null,
					authenticationTag: null,
				},
			});
			await tx.passwordCredential.create({
				data: {
					userId: staff.userId,
					passwordHash: row.passwordHash,
					normalization: 'nfc',
				},
			});
			await tx.platformTotpCredential.create({
				data: {
					platformStaffId: staff.id,
					encryptedSecret: row.encryptedSecret,
					initializationVector: row.initializationVector,
					authenticationTag: row.authenticationTag,
					encryptionKeyId: row.encryptionKeyId,
					encryptionVersion: row.encryptionVersion,
					verifiedAt: now,
					lastUsedAt: now,
					lastAcceptedTimeStep: step.timeStep,
				},
			});
			// Inserting a verified factor advances recovery_generation via the canonical DB trigger.
			const updated = await tx.platformStaff.update({
				where: { id: staff.id },
				data: { status: PlatformStaffStatus.ACTIVE },
			});
			const user = await tx.user.update({
				where: { id: staff.userId },
				data: {
					status: UserStatus.ACTIVE,
					emailVerifiedAt: now,
					identityVersion: { increment: 1 },
				},
			});
			const recoveryCodes = this.tokens.createRecoveryCodes();
			await tx.platformRecoveryCode.createMany({
				data: recoveryCodes.map((code) => ({
					platformStaffId: staff.id,
					generation: updated.recoveryGeneration,
					digestVersion: 2,
					codeDigest: this.tokens.recoveryCodeDigest(code),
				})),
			});
			const actor = { actorKind: 'bootstrap' as const, actorPlatformStaffId: staff.id, requestId };
			await recordIdentityEvent(tx, actor, {
				userId: user.id,
				action: 'email_verified',
				identityVersion: user.identityVersion,
			});
			await recordIdentityEvent(tx, actor, {
				userId: user.id,
				action: 'password_created',
				identityVersion: user.identityVersion,
				credentialVersion: 1,
			});
			await recordPlatformAuthentication(tx, user, 'mfa_factor_enrolled', requestId);
			await recordPlatformAuthentication(tx, user, 'mfa_recovery_rotated', requestId);
			return { recoveryCodes };
		});
		if (result === null) throw invalid();
		return result;
	}

	async cancel(token: string): Promise<void> {
		await this.withProof(token, async (tx, row, _staff, now) => {
			await tx.platformOwnerEnrollment.update({
				where: { id: row.id },
				data: {
					consumedAt: now,
					passwordHash: null,
					setupVersion: 0,
					encryptedSecret: null,
					encryptionKeyId: null,
					encryptionVersion: null,
					initializationVector: null,
					authenticationTag: null,
				},
			});
		});
	}

	private digest(purpose: 'mailbox' | 'session', token: string): string {
		return this.tokens.digest(JSON.stringify(['platform-owner-enrollment-v1', purpose, token]));
	}

	private usable(
		row: {
			consumedAt: Date | null;
			expiresAt: Date;
			failedAttempts: number;
			email: string;
			identityVersion: number;
		},
		user: { email: string; identityVersion: number },
		now: Date,
	): boolean {
		return (
			row.consumedAt === null &&
			row.expiresAt > now &&
			row.failedAttempts < MAX_ATTEMPTS &&
			row.email === user.email &&
			row.identityVersion === user.identityVersion
		);
	}

	private async pendingOwner(tx: Prisma.TransactionClient) {
		if ((await tx.platformStaff.count()) !== 1) throw invalid();
		const staff = await tx.platformStaff.findFirst({
			include: {
				user: { include: { passwordCredential: true } },
				totpCredential: true,
				roles: { include: { platformRole: true } },
			},
		});
		if (
			staff?.status !== PlatformStaffStatus.PENDING ||
			staff.user.status !== UserStatus.PENDING ||
			staff.user.emailVerifiedAt !== null ||
			staff.user.passwordCredential !== null ||
			staff.totpCredential !== null ||
			staff.roles.length !== 1 ||
			!staff.roles.some(
				({ platformRole }) => platformRole.key === 'platform.owner' && platformRole.isSystem,
			)
		)
			throw invalid();
		return staff;
	}

	private async withProof<T>(
		token: string,
		operation: (
			tx: Prisma.TransactionClient,
			row: PlatformOwnerEnrollment,
			staff: Awaited<ReturnType<PlatformOwnerEnrollmentService['pendingOwner']>>,
			now: Date,
		) => T | Promise<T>,
	): Promise<T> {
		if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalid();
		return this.transaction(async (tx, now) => {
			const staff = await this.pendingOwner(tx);
			const row = await tx.platformOwnerEnrollment.findUnique({
				where: { sessionDigest: this.digest('session', token) },
			});
			if (
				row?.platformStaffId !== staff.id ||
				row.exchangedAt === null ||
				!this.usable(row, staff.user, now)
			)
				throw invalid();
			return operation(tx, row, staff, now);
		});
	}

	private async transaction<T>(
		operation: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
	): Promise<T> {
		if (!this.config.get('PLATFORM_OWNER_BOOTSTRAP_ENABLED', { infer: true }))
			throw new ApiProblemException('SERVICE_UNAVAILABLE');
		try {
			return await this.prisma.$transaction(
				async (tx) => {
					await acquireBootstrapLock(tx);
					const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
					if (clock === undefined) throw invalid();
					return operation(tx, clock.now);
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 5000,
					timeout: 10_000,
				},
			);
		} catch (error: unknown) {
			if (error instanceof ApiProblemException) throw error;
			throw new ApiProblemException('SERVICE_UNAVAILABLE', [], error);
		}
	}
}

function invalid(): ApiProblemException {
	return new ApiProblemException('AUTH_MFA_INVALID');
}
