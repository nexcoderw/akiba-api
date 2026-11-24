import { randomUUID } from 'node:crypto';
import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import {
	Injectable,
	Logger,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformStaffStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import type { PlatformMfaVerifiedResponseDto } from './dto/platform-auth-response.dto.js';
import type { PlatformMfaVerifyDto } from './dto/platform-mfa-verify.dto.js';
import { PLATFORM_AUTH_ERROR } from './platform-auth.constants.js';
import { PlatformTokenService } from './platform-token.service.js';
import { PlatformTotpService } from './platform-totp.service.js';
import { effectivePlatformPermissions } from './platform-permission-policy.js';
import { recordPlatformAuthentication } from './platform-authentication-audit.js';
import { consumePlatformRecoveryCode } from './platform-recovery-code.js';

export type PlatformMfaVerificationInput = PlatformMfaVerifyDto & {
	readonly challengeToken: string;
};

export class PlatformMfaRejectedException extends UnauthorizedException {
	constructor(readonly terminal: boolean) {
		super(PLATFORM_AUTH_ERROR.invalidChallenge);
	}
}

export interface PlatformMfaSuccess {
	readonly status: PlatformMfaVerifiedResponseDto['status'];
	readonly expiresAt: string;
	readonly sessionToken: string;
	readonly expiresAtDate: Date;
}

type VerificationOutcome =
	| {
			readonly authenticated: false;
			readonly challengeId: string | null;
			readonly terminal: boolean;
	  }
	| {
			readonly authenticated: true;
			readonly challengeId: string;
			readonly platformStaffId: string;
			readonly expiresAt: Date;
	  };

class ConcurrentMfaConsumptionError extends Error {
	override readonly name = 'ConcurrentMfaConsumptionError';
}

const MFA_TRANSACTION_MAX_WAIT_MS = 8_000;
const MFA_TRANSACTION_TIMEOUT_MS = 10_000;
const VERIFICATION_STATUS = {
	totp: 'authenticated',
	recovery_code: 'mfa_recovery_required',
	email_otp: 'email_verified',
} as const;

@Injectable()
export class PlatformMfaService {
	private readonly logger = new Logger(PlatformMfaService.name);
	private readonly sessionLifetimeMilliseconds: number;
	private readonly idleLifetimeMilliseconds: number;
	private readonly emailOtpEnabled: boolean;
	private readonly transactionMaxWaitMilliseconds: number;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly tokens: PlatformTokenService,
		private readonly totp: PlatformTotpService,
	) {
		this.sessionLifetimeMilliseconds =
			config.get('PLATFORM_AUTH_SESSION_TTL_SECONDS', { infer: true }) * 1000;
		this.idleLifetimeMilliseconds =
			config.get('PLATFORM_AUTH_IDLE_TTL_SECONDS', { infer: true }) * 1000;
		this.emailOtpEnabled = config.get('PLATFORM_AUTH_EMAIL_OTP_ENABLED', { infer: true });
		this.transactionMaxWaitMilliseconds = Math.min(
			config.get('DATABASE_CONNECTION_TIMEOUT_MS', { infer: true }),
			MFA_TRANSACTION_MAX_WAIT_MS,
		);
	}

	async verify(
		input: PlatformMfaVerificationInput,
		now = new Date(),
		requestId?: string,
	): Promise<PlatformMfaSuccess> {
		if (!/^[A-Za-z0-9_-]{32,256}$/u.test(input.challengeToken))
			throw new PlatformMfaRejectedException(true);
		this.assertMethodInput(input);
		const challengeDigest = this.tokens.digest(input.challengeToken);
		const sessionToken = this.tokens.createToken();
		let outcome: VerificationOutcome;
		try {
			outcome = await this.prisma.$transaction(
				async (transaction): Promise<VerificationOutcome> => {
					const current = await transaction.platformMfaChallenge.findUnique({
						where: { tokenDigest: challengeDigest },
						select: {
							id: true,
							purpose: true,
							mfaVersion: true,
							platformStaffId: true,
							expiresAt: true,
							consumedAt: true,
							failedAttempts: true,
							maxAttempts: true,
							createdAt: true,
							emailOtpDigest: true,
							emailOtpExpiresAt: true,
							platformStaff: {
								select: {
									status: true,
									mfaVersion: true,
									recoveryGeneration: true,
									user: {
										select: {
											id: true,
											identityVersion: true,
											status: true,
											emailVerifiedAt: true,
											email: true,
											passwordCredential: { select: { passwordChangedAt: true, disabledAt: true } },
										},
									},
									roles: {
										select: {
											platformRole: {
												select: {
													key: true,
													isSystem: true,
													permissions: {
														select: { platformPermission: { select: { key: true } } },
													},
												},
											},
										},
									},
									totpCredential: {
										select: {
											id: true,
											encryptedSecret: true,
											initializationVector: true,
											authenticationTag: true,
											encryptionKeyId: true,
											encryptionVersion: true,
											verifiedAt: true,
											disabledAt: true,
										},
									},
								},
							},
						},
					});
					if (
						current?.purpose !== 'login' ||
						current.mfaVersion !== current.platformStaff.mfaVersion ||
						current.consumedAt !== null ||
						current.expiresAt <= now ||
						current.failedAttempts >= current.maxAttempts ||
						current.platformStaff.status !== PlatformStaffStatus.ACTIVE ||
						!accountCanAuthenticate(
							current.platformStaff.user.status,
							current.platformStaff.user.emailVerifiedAt,
						) ||
						current.platformStaff.user.passwordCredential?.disabledAt !== null ||
						current.platformStaff.user.passwordCredential.passwordChangedAt > current.createdAt ||
						effectivePlatformPermissions(current.platformStaff.roles).length === 0
					) {
						return { authenticated: false, challengeId: current?.id ?? null, terminal: true };
					}
					const credential = current.platformStaff.totpCredential;
					const acceptedTotp =
						input.method === 'totp' && input.totpCode !== undefined && credential !== null
							? this.totp.verify(
									{
										platformStaffId: current.platformStaffId,
										encryptedSecret: credential.encryptedSecret,
										initializationVector: credential.initializationVector,
										authenticationTag: credential.authenticationTag,
										encryptionKeyId: credential.encryptionKeyId,
										encryptionVersion: credential.encryptionVersion,
									},
									input.totpCode,
									now,
								)
							: null;

					const factorAccepted =
						input.method === 'email_otp'
							? await this.consumeEmailOtp(transaction, current, input.emailOtpCode, now)
							: await this.consumeFactor(
									transaction,
									input,
									current.platformStaffId,
									current.platformStaff.recoveryGeneration,
									current.platformStaff.totpCredential,
									acceptedTotp?.timeStep,
									now,
								);
					if (!factorAccepted) {
						await transaction.platformMfaChallenge.updateMany({
							where: {
								id: current.id,
								consumedAt: null,
								failedAttempts: { lt: current.maxAttempts },
							},
							data: { failedAttempts: { increment: 1 } },
						});
						await recordPlatformAuthentication(
							transaction,
							current.platformStaff.user,
							'platform_mfa_rejected',
							requestId,
						);
						return {
							authenticated: false,
							challengeId: current.id,
							terminal: current.failedAttempts + 1 >= current.maxAttempts,
						};
					}

					const consumed = await transaction.platformMfaChallenge.updateMany({
						where: {
							id: current.id,
							consumedAt: null,
							expiresAt: { gt: now },
							failedAttempts: { lt: current.maxAttempts },
						},
						data: { consumedAt: now },
					});
					if (consumed.count !== 1) {
						throw new ConcurrentMfaConsumptionError();
					}

					if (input.method === 'recovery_code') {
						await transaction.platformAdminSession.updateMany({
							where: { platformStaffId: current.platformStaffId, revokedAt: null },
							data: { revokedAt: now, revocationReason: 'recovery_used' },
						});
						await transaction.platformMfaChallenge.updateMany({
							where: {
								platformStaffId: current.platformStaffId,
								id: { not: current.id },
								consumedAt: null,
							},
							data: { consumedAt: now },
						});
						await recordPlatformAuthentication(
							transaction,
							current.platformStaff.user,
							'mfa_recovery_used',
							requestId,
						);
						await transaction.platformSecurityNotification.create({
							data: {
								platformStaffId: current.platformStaffId,
								recipient: current.platformStaff.user.email,
								event: 'mfa_recovery_used',
								requestId: requestId ?? `req_${randomUUID()}`,
							},
						});
					}

					const lifetime = input.method === 'totp' ? this.sessionLifetimeMilliseconds : 300_000;
					const expiresAt = new Date(now.getTime() + lifetime);
					await transaction.platformAdminSession.create({
						data: {
							platformStaffId: current.platformStaffId,
							authenticationMethod: input.method,
							mfaVersion: current.platformStaff.mfaVersion,
							createdAt: now,
							tokenDigest: this.tokens.digest(sessionToken),
							expiresAt,
							idleExpiresAt: new Date(
								Math.min(expiresAt.getTime(), now.getTime() + this.idleLifetimeMilliseconds),
							),
							lastSeenAt: now,
							mfaVerifiedAt: now,
						},
					});
					await recordPlatformAuthentication(
						transaction,
						current.platformStaff.user,
						'platform_session_issued',
						requestId,
					);
					return {
						authenticated: true,
						challengeId: current.id,
						platformStaffId: current.platformStaffId,
						expiresAt,
					};
				},
				{
					// Include live account and role reads in the atomic authentication decision.
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: this.transactionMaxWaitMilliseconds,
					timeout: MFA_TRANSACTION_TIMEOUT_MS,
				},
			);
		} catch (error: unknown) {
			if (error instanceof ConcurrentMfaConsumptionError) {
				throw new PlatformMfaRejectedException(true);
			}
			throw this.persistenceFailure(error);
		}

		if (!outcome.authenticated) {
			this.logger.warn(
				JSON.stringify({
					event: 'platform_mfa_rejected',
					challengeId: outcome.challengeId,
					requestId,
				}),
			);
			throw new PlatformMfaRejectedException(outcome.terminal);
		}
		this.logger.log(
			JSON.stringify({
				event: 'platform_session_created',
				staffId: outcome.platformStaffId,
				requestId,
			}),
		);
		return {
			status: VERIFICATION_STATUS[input.method],
			expiresAt: outcome.expiresAt.toISOString(),
			expiresAtDate: outcome.expiresAt,
			sessionToken,
		};
	}

	async revokeChallenge(
		token: string | undefined,
		now = new Date(),
		requestId?: string,
	): Promise<void> {
		if (token === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(token)) return;
		try {
			await this.prisma.$transaction(
				async (transaction) => {
					const challenge = await transaction.platformMfaChallenge.findUnique({
						where: { tokenDigest: this.tokens.digest(token) },
						select: {
							id: true,
							consumedAt: true,
							platformStaff: { select: { user: { select: { id: true, identityVersion: true } } } },
						},
					});
					if (challenge?.consumedAt !== null) return;
					const revoked = await transaction.platformMfaChallenge.updateMany({
						where: { id: challenge.id, consumedAt: null },
						data: { consumedAt: now, emailOtpDigest: null, emailOtpExpiresAt: null },
					});
					if (revoked.count === 1)
						await recordPlatformAuthentication(
							transaction,
							challenge.platformStaff.user,
							'platform_challenge_revoked',
							requestId,
						);
				},
				{ maxWait: this.transactionMaxWaitMilliseconds, timeout: MFA_TRANSACTION_TIMEOUT_MS },
			);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}
	}

	private persistenceFailure(error: unknown): Error {
		return new ServiceUnavailableException(
			{
				code: 'PLATFORM_MFA_UNAVAILABLE',
				message: 'MFA verification is temporarily unavailable. Start sign-in again.',
			},
			{ cause: error },
		);
	}

	private async consumeFactor(
		transaction: Prisma.TransactionClient,
		input: PlatformMfaVerifyDto,
		platformStaffId: string,
		recoveryGeneration: number,
		totpCredential: {
			readonly id: string;
			readonly verifiedAt: Date | null;
			readonly disabledAt: Date | null;
		} | null,
		acceptedTimeStep: bigint | undefined,
		now: Date,
	): Promise<boolean> {
		if (input.method === 'totp') {
			if (
				totpCredential?.verifiedAt === null ||
				totpCredential?.disabledAt !== null ||
				acceptedTimeStep === undefined
			) {
				return false;
			}
			const accepted = await transaction.platformTotpCredential.updateMany({
				where: {
					id: totpCredential.id,
					platformStaffId,
					verifiedAt: { not: null },
					disabledAt: null,
					OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: acceptedTimeStep } }],
				},
				data: { lastAcceptedTimeStep: acceptedTimeStep, lastUsedAt: now },
			});
			return accepted.count === 1;
		}

		if (input.recoveryCode === undefined) {
			return false;
		}
		return consumePlatformRecoveryCode(
			transaction,
			this.tokens,
			platformStaffId,
			recoveryGeneration,
			input.recoveryCode,
			now,
		);
	}

	private async consumeEmailOtp(
		transaction: Prisma.TransactionClient,
		challenge: {
			readonly id: string;
			readonly emailOtpDigest: string | null;
			readonly emailOtpExpiresAt: Date | null;
			readonly platformStaff: { readonly user: { readonly email: string } };
		},
		code: string | undefined,
		now: Date,
	): Promise<boolean> {
		if (
			!this.emailOtpEnabled ||
			code === undefined ||
			challenge.emailOtpDigest === null ||
			challenge.emailOtpExpiresAt === null ||
			challenge.emailOtpExpiresAt <= now
		)
			return false;
		const digest = this.tokens.emailOtpDigest(
			challenge.id,
			challenge.platformStaff.user.email,
			code,
		);
		if (!this.tokens.equal(digest, challenge.emailOtpDigest)) return false;
		const consumed = await transaction.platformMfaChallenge.updateMany({
			where: {
				id: challenge.id,
				consumedAt: null,
				emailOtpDigest: digest,
				emailOtpExpiresAt: { gt: now },
			},
			data: { emailOtpDigest: null, emailOtpExpiresAt: null },
		});
		return consumed.count === 1;
	}

	private assertMethodInput(input: PlatformMfaVerifyDto): void {
		const valid =
			(input.method === 'email_otp' &&
				this.emailOtpEnabled &&
				input.emailOtpCode !== undefined &&
				/^\d{6}$/u.test(input.emailOtpCode) &&
				input.totpCode === undefined &&
				input.recoveryCode === undefined) ||
			(input.method === 'totp' &&
				input.emailOtpCode === undefined &&
				input.totpCode !== undefined &&
				/^\d{6}$/u.test(input.totpCode) &&
				input.recoveryCode === undefined) ||
			(input.method === 'recovery_code' &&
				input.emailOtpCode === undefined &&
				input.recoveryCode !== undefined &&
				input.recoveryCode.length >= 12 &&
				input.recoveryCode.length <= 128 &&
				input.totpCode === undefined);
		if (!valid) {
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidChallenge);
		}
	}
}
