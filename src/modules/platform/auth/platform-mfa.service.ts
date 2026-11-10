import {
	Injectable,
	Logger,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformStaffStatus, Prisma, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { databaseErrorCode } from '../../../common/errors/database-error-code.js';
import type { PlatformMfaVerifyDto } from './dto/platform-mfa-verify.dto.js';
import { PLATFORM_AUTH_ERROR } from './platform-auth.constants.js';
import { PlatformTokenService } from './platform-token.service.js';
import { PlatformTotpService } from './platform-totp.service.js';
import { isPlatformSuperadmin } from './platform-permission-policy.js';

export interface PlatformMfaSuccess {
	readonly status: 'authenticated';
	readonly expiresAt: string;
	readonly sessionToken: string;
	readonly expiresAtDate: Date;
}

type VerificationOutcome =
	| { readonly authenticated: false; readonly challengeId: string | null }
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
const MFA_PERSISTENCE_ERROR_CODES = new Set([
	'P1001',
	'P1002',
	'P1008',
	'P1010',
	'P1017',
	'P2021',
	'P2022',
	'P2024',
	'P2028',
	'P2034',
	'P2037',
	'P2039',
]);

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

	async verify(input: PlatformMfaVerifyDto, now = new Date()): Promise<PlatformMfaSuccess> {
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
									user: {
										select: {
											status: true,
											emailVerifiedAt: true,
											email: true,
											passwordCredential: { select: { passwordChangedAt: true } },
										},
									},
									roles: {
										select: {
											platformRole: {
												select: {
													key: true,
													isSystem: true,
													permissions: { select: { platformPermissionId: true }, take: 1 },
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
						current?.consumedAt !== null ||
						current.expiresAt <= now ||
						current.failedAttempts >= current.maxAttempts ||
						current.platformStaff.status !== PlatformStaffStatus.ACTIVE ||
						current.platformStaff.user.status !== UserStatus.ACTIVE ||
						current.platformStaff.user.emailVerifiedAt === null ||
						current.platformStaff.user.passwordCredential === null ||
						current.platformStaff.user.passwordCredential.passwordChangedAt > current.createdAt ||
						(!isPlatformSuperadmin(current.platformStaff.roles) &&
							!current.platformStaff.roles.some(
								({ platformRole }) => platformRole.permissions.length > 0,
							))
					) {
						return { authenticated: false, challengeId: current?.id ?? null };
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
						return { authenticated: false, challengeId: current.id };
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

					const expiresAt = new Date(now.getTime() + this.sessionLifetimeMilliseconds);
					await transaction.platformAdminSession.create({
						data: {
							platformStaffId: current.platformStaffId,
							tokenDigest: this.tokens.digest(sessionToken),
							expiresAt,
							idleExpiresAt: new Date(now.getTime() + this.idleLifetimeMilliseconds),
							lastSeenAt: now,
							mfaVerifiedAt: now,
						},
					});
					return {
						authenticated: true,
						challengeId: current.id,
						platformStaffId: current.platformStaffId,
						expiresAt,
					};
				},
				{
					// Conditional consumes provide concurrency safety without serializable conflicts.
					isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
					maxWait: this.transactionMaxWaitMilliseconds,
					timeout: MFA_TRANSACTION_TIMEOUT_MS,
				},
			);
		} catch (error: unknown) {
			if (error instanceof ConcurrentMfaConsumptionError) {
				throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidChallenge);
			}
			throw this.persistenceFailure(error);
		}

		if (!outcome.authenticated) {
			this.logger.warn(
				JSON.stringify({ event: 'platform_mfa_rejected', challengeId: outcome.challengeId }),
			);
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidChallenge);
		}
		this.logger.log(
			JSON.stringify({ event: 'platform_session_created', staffId: outcome.platformStaffId }),
		);
		return {
			status: 'authenticated',
			expiresAt: outcome.expiresAt.toISOString(),
			expiresAtDate: outcome.expiresAt,
			sessionToken,
		};
	}

	private persistenceFailure(error: unknown): Error {
		const code = databaseErrorCode(error);
		if (code !== undefined && MFA_PERSISTENCE_ERROR_CODES.has(code)) {
			return new ServiceUnavailableException(
				{
					code: 'PLATFORM_MFA_UNAVAILABLE',
					message: 'MFA verification is temporarily unavailable. Start sign-in again.',
				},
				{ cause: error },
			);
		}
		return error instanceof Error ? error : new Error('Unexpected MFA persistence failure.');
	}

	private async consumeFactor(
		transaction: Prisma.TransactionClient,
		input: PlatformMfaVerifyDto,
		platformStaffId: string,
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
		const consumed = await transaction.platformRecoveryCode.updateMany({
			where: {
				platformStaffId,
				codeDigest: this.tokens.digest(input.recoveryCode.trim().toUpperCase()),
				usedAt: null,
			},
			data: { usedAt: now },
		});
		return consumed.count === 1;
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
				input.recoveryCode === undefined) ||
			(input.method === 'recovery_code' &&
				input.emailOtpCode === undefined &&
				input.recoveryCode !== undefined &&
				input.totpCode === undefined);
		if (!valid) {
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidChallenge);
		}
	}
}
