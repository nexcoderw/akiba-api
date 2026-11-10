import { normalizeEmailIdentity } from '../../../common/identity/email-identity.js';
import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import {
	Injectable,
	Logger,
	PreconditionFailedException,
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
	): Promise<PlatformMfaChallengeResponseDto> {
		const email = normalizeEmailIdentity(input.email);
		if (email === null) throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidCredentials);
		this.attempts.assertAllowed(ipAddress, email, now.getTime());
		let identity: Awaited<ReturnType<typeof this.readIdentity>>;
		try {
			identity = await this.readIdentity(email);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}

		const passwordHash = identity?.passwordCredential?.passwordHash ?? this.passwords.dummyHash;
		const passwordValid = await this.passwords.verify(
			passwordHash,
			input.password,
			identity?.passwordCredential?.normalization ?? 'raw',
		);
		if (
			!passwordValid ||
			identity === null ||
			!accountCanAuthenticate(identity.status, identity.emailVerifiedAt) ||
			identity.passwordCredential?.disabledAt !== null ||
			identity.platformStaff?.status !== PlatformStaffStatus.ACTIVE
		) {
			this.attempts.recordFailure(ipAddress, email, now.getTime());
			this.logger.warn(JSON.stringify({ event: 'platform_login_rejected' }));
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidCredentials);
		}
		const platformStaff = identity.platformStaff;

		const totpAvailable =
			platformStaff.totpCredential?.verifiedAt !== null &&
			platformStaff.totpCredential?.verifiedAt !== undefined &&
			platformStaff.totpCredential.disabledAt === null;
		const recoveryAvailable = platformStaff.recoveryCodes.length > 0;
		if (!totpAvailable && !recoveryAvailable) {
			throw new PreconditionFailedException({
				code: 'PLATFORM_MFA_SETUP_REQUIRED',
				message: 'A confirmed MFA factor is required before platform access',
			});
		}

		const challengeToken = this.tokens.createToken();
		const csrfToken = this.tokens.createToken();
		const expiresAt = new Date(now.getTime() + this.challengeLifetimeMilliseconds);
		try {
			await this.prisma.$transaction(
				[
					this.prisma.platformMfaChallenge.updateMany({
						where: {
							platformStaffId: platformStaff.id,
							consumedAt: null,
							expiresAt: { gt: now },
						},
						data: { consumedAt: now },
					}),
					this.prisma.platformMfaChallenge.create({
						data: {
							platformStaffId: platformStaff.id,
							tokenDigest: this.tokens.digest(challengeToken),
							// Bind MFA to the password proof's start, not a later insertion time.
							createdAt: now,
							expiresAt,
							maxAttempts: this.maximumAttempts,
						},
					}),
				],
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
			);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}
		this.attempts.clearAccount(email);
		this.logger.log(
			JSON.stringify({ event: 'platform_mfa_challenge_created', staffId: platformStaff.id }),
		);

		return {
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

	private readIdentity(email: string) {
		return this.prisma.user.findUnique({
			where: { email },
			select: {
				id: true,
				status: true,
				emailVerifiedAt: true,
				passwordCredential: {
					select: { passwordHash: true, normalization: true, disabledAt: true },
				},
				platformStaff: {
					select: {
						id: true,
						status: true,
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
		return new ServiceUnavailableException(
			{
				code: 'PLATFORM_LOGIN_UNAVAILABLE',
				message: 'Sign-in is temporarily unavailable. Try again.',
			},
			{ cause: error },
		);
	}
}
