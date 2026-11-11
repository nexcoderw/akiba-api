import { normalizeEmailIdentity } from '../../../common/identity/email-identity.js';
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
import type { PlatformMfaChallengeResponseDto } from './dto/platform-auth-response.dto.js';
import type { PlatformLoginDto } from './dto/platform-login.dto.js';
import { PLATFORM_AUTH_ERROR } from './platform-auth.constants.js';
import { PlatformLoginAttemptService } from './platform-login-attempt.service.js';
import { PlatformPasswordService } from './platform-password.service.js';
import { PlatformTokenService } from './platform-token.service.js';
import { effectivePlatformPermissions } from './platform-permission-policy.js';
import { recordPlatformAuthentication } from './platform-authentication-audit.js';

/** Internal result: the controller puts the proof in an HttpOnly cookie. */
export interface PlatformLoginChallenge extends PlatformMfaChallengeResponseDto {
	readonly challengeToken: string;
}

@Injectable()
export class PlatformLoginService {
	private readonly logger = new Logger(PlatformLoginService.name);
	private readonly challengeLifetimeMilliseconds: number;
	private readonly maximumAttempts: number;
	private readonly emailOtpEnabled: boolean;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly passwords: PlatformPasswordService,
		private readonly tokens: PlatformTokenService,
		private readonly attempts: PlatformLoginAttemptService,
	) {
		this.challengeLifetimeMilliseconds =
			config.get('PLATFORM_AUTH_MFA_CHALLENGE_TTL_SECONDS', { infer: true }) * 1000;
		this.maximumAttempts = config.get('PLATFORM_AUTH_MFA_MAX_ATTEMPTS', { infer: true });
		this.emailOtpEnabled = config.get('PLATFORM_AUTH_EMAIL_OTP_ENABLED', { infer: true });
	}

	async login(
		input: PlatformLoginDto,
		ipAddress: string,
		now = new Date(),
		requestId?: string,
	): Promise<PlatformLoginChallenge> {
		const email = normalizeEmailIdentity(input.email);
		if (email === null) throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidCredentials);
		// Reserve before asynchronous work, including successful passwords and dependency failures.
		try {
			this.attempts.consume(ipAddress, email, now.getTime());
		} catch (error: unknown) {
			this.logger.warn(JSON.stringify({ event: 'platform_login_admission_rejected', requestId }));
			throw error;
		}
		let identity: Awaited<ReturnType<typeof this.readIdentity>>;
		try {
			identity = await this.readIdentity(email);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}

		const passwordHash = identity?.passwordCredential?.passwordHash ?? this.passwords.dummyHash;
		let passwordValid: boolean;
		try {
			passwordValid = await this.passwords.verify(
				passwordHash,
				input.password,
				identity?.passwordCredential?.normalization ?? 'raw',
			);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}
		if (
			!passwordValid ||
			identity === null ||
			!accountCanAuthenticate(identity.status, identity.emailVerifiedAt) ||
			identity.passwordCredential?.disabledAt !== null ||
			identity.platformStaff?.status !== PlatformStaffStatus.ACTIVE
		) {
			this.logger.warn(
				JSON.stringify({
					event: 'platform_login_rejected',
					accountKey: this.tokens.digest(JSON.stringify(['platform-login-account-v1', email])),
					requestId,
				}),
			);
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidCredentials);
		}
		const platformStaff = identity.platformStaff;
		const identityVersion = identity.identityVersion;

		const totpAvailable =
			platformStaff.totpCredential?.verifiedAt !== null &&
			platformStaff.totpCredential?.verifiedAt !== undefined &&
			platformStaff.totpCredential.disabledAt === null;
		const recoveryAvailable = platformStaff.recoveryCodes.length > 0;
		if (
			(!totpAvailable && !recoveryAvailable) ||
			effectivePlatformPermissions(platformStaff.roles).length === 0
		) {
			this.logger.warn(JSON.stringify({ event: 'platform_login_rejected', requestId }));
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidCredentials);
		}

		const challengeToken = this.tokens.createToken();
		const csrfToken = this.tokens.createToken();
		const expiresAt = new Date(now.getTime() + this.challengeLifetimeMilliseconds);
		try {
			await this.prisma.$transaction(
				async (transaction) => {
					const current = await this.readIdentity(email, transaction);
					if (
						current === null ||
						!accountCanAuthenticate(current.status, current.emailVerifiedAt) ||
						current.identityVersion !== identityVersion ||
						current.passwordCredential?.disabledAt !== null ||
						current.passwordCredential.passwordHash !== passwordHash ||
						current.platformStaff?.id !== platformStaff.id ||
						current.platformStaff.status !== PlatformStaffStatus.ACTIVE ||
						effectivePlatformPermissions(current.platformStaff.roles).length === 0
					)
						throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidCredentials);
					await transaction.platformMfaChallenge.updateMany({
						where: {
							platformStaffId: platformStaff.id,
							consumedAt: null,
							expiresAt: { gt: now },
						},
						data: { consumedAt: now },
					});
					await transaction.platformMfaChallenge.create({
						data: {
							platformStaffId: platformStaff.id,
							tokenDigest: this.tokens.digest(challengeToken),
							// Bind MFA to the password proof's start, not a later insertion time.
							createdAt: now,
							expiresAt,
							maxAttempts: this.maximumAttempts,
						},
					});
					await recordPlatformAuthentication(
						transaction,
						current,
						'platform_primary_authenticated',
						requestId,
					);
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 5000,
					timeout: 10_000,
				},
			);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}
		this.logger.log(
			JSON.stringify({
				event: 'platform_mfa_challenge_created',
				staffId: platformStaff.id,
				requestId,
			}),
		);

		return {
			status: 'MFA_REQUIRED',
			nextStep: 'VERIFY_MFA',
			challengeToken,
			csrfToken,
			expiresAt: expiresAt.toISOString(),
			methods: [
				...(this.emailOtpEnabled ? (['email_otp'] as const) : []),
				...(totpAvailable ? (['totp'] as const) : []),
				...(recoveryAvailable ? (['recovery_code'] as const) : []),
			],
		};
	}

	private readIdentity(
		email: string,
		client: Pick<Prisma.TransactionClient, 'user'> = this.prisma,
	) {
		return client.user.findUnique({
			where: { email },
			select: {
				id: true,
				identityVersion: true,
				status: true,
				emailVerifiedAt: true,
				passwordCredential: {
					select: { passwordHash: true, normalization: true, disabledAt: true },
				},
				platformStaff: {
					select: {
						id: true,
						status: true,
						roles: {
							select: {
								platformRole: {
									select: {
										key: true,
										isSystem: true,
										permissions: { select: { platformPermission: { select: { key: true } } } },
									},
								},
							},
						},
						totpCredential: {
							select: { verifiedAt: true, disabledAt: true },
						},
						recoveryCodes: {
							where: { usedAt: null },
							select: { id: true },
							take: 1,
						},
					},
				},
			},
		});
	}

	private persistenceFailure(error: unknown): Error {
		if (error instanceof UnauthorizedException) return error;
		return new ServiceUnavailableException(
			{
				code: 'PLATFORM_LOGIN_UNAVAILABLE',
				message: 'Sign-in is temporarily unavailable. Try again.',
			},
			{ cause: error },
		);
	}
}
