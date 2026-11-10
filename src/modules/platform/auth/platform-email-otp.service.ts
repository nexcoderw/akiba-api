import { randomInt, randomUUID } from 'node:crypto';
import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformStaffStatus, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { ResendEmailService } from '../../../infrastructure/email/resend-email.service.js';
import type { PlatformEmailOtpSentResponseDto } from './dto/platform-auth-response.dto.js';
import { PLATFORM_AUTH_ERROR } from './platform-auth.constants.js';
import { PlatformTokenService } from './platform-token.service.js';
import { isPlatformSuperadmin } from './platform-permission-policy.js';
import { PLATFORM_SUPERADMIN_ROLE_KEY } from './platform-permission.constants.js';

const COOLDOWN_SECONDS = 60;
const MAX_SENDS = 3;

/** A password challenge authorizes delivery only to its eligible staff member's verified mailbox. */
@Injectable()
export class PlatformEmailOtpService {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly tokens: PlatformTokenService,
		private readonly email: ResendEmailService,
	) {}

	async send(challengeToken: string, now = new Date()): Promise<PlatformEmailOtpSentResponseDto> {
		if (!this.config.get('PLATFORM_AUTH_EMAIL_OTP_ENABLED', { infer: true })) {
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidChallenge);
		}
		const challenge = await this.prisma.platformMfaChallenge.findUnique({
			where: { tokenDigest: this.tokens.digest(challengeToken) },
			select: {
				id: true,
				createdAt: true,
				consumedAt: true,
				expiresAt: true,
				failedAttempts: true,
				maxAttempts: true,
				emailOtpSendCount: true,
				emailOtpSentAt: true,
				platformStaff: {
					select: {
						status: true,
						user: {
							select: {
								status: true,
								email: true,
								emailVerifiedAt: true,
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
					},
				},
			},
		});
		if (
			challenge?.consumedAt !== null ||
			challenge.expiresAt <= now ||
			challenge.failedAttempts >= challenge.maxAttempts ||
			challenge.platformStaff.status !== PlatformStaffStatus.ACTIVE ||
			challenge.platformStaff.user.status !== UserStatus.ACTIVE ||
			challenge.platformStaff.user.emailVerifiedAt === null ||
			challenge.platformStaff.user.passwordCredential === null ||
			challenge.platformStaff.user.passwordCredential.passwordChangedAt > challenge.createdAt ||
			(!isPlatformSuperadmin(challenge.platformStaff.roles) &&
				!challenge.platformStaff.roles.some(
					({ platformRole }) => platformRole.permissions.length > 0,
				))
		) {
			throw new UnauthorizedException(PLATFORM_AUTH_ERROR.invalidChallenge);
		}
		const cooldownBefore = new Date(now.getTime() - COOLDOWN_SECONDS * 1000);
		if (
			challenge.emailOtpSendCount >= MAX_SENDS ||
			(challenge.emailOtpSentAt !== null && challenge.emailOtpSentAt > cooldownBefore)
		) {
			throw limited();
		}
		const recipient = challenge.platformStaff.user.email;
		const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
		const digest = this.tokens.emailOtpDigest(challenge.id, recipient, code);
		const expiresAt = new Date(Math.min(challenge.expiresAt.getTime(), now.getTime() + 300_000));
		// Compare-and-set reserves one send across replicas and replaces every previous code.
		const reserved = await this.prisma.platformMfaChallenge.updateMany({
			where: {
				id: challenge.id,
				consumedAt: null,
				expiresAt: { gt: now },
				failedAttempts: { lt: challenge.maxAttempts },
				emailOtpSendCount: { lt: MAX_SENDS },
				OR: [{ emailOtpSentAt: null }, { emailOtpSentAt: { lte: cooldownBefore } }],
				platformStaff: {
					status: PlatformStaffStatus.ACTIVE,
					roles: {
						some: {
							platformRole: {
								OR: [
									{ key: PLATFORM_SUPERADMIN_ROLE_KEY, isSystem: true },
									{ permissions: { some: {} } },
								],
							},
						},
					},
					user: {
						status: UserStatus.ACTIVE,
						email: recipient,
						emailVerifiedAt: { not: null },
						passwordCredential: { passwordChangedAt: { lte: challenge.createdAt } },
					},
				},
			},
			data: {
				emailOtpDigest: digest,
				emailOtpExpiresAt: expiresAt,
				emailOtpSentAt: now,
				emailOtpSendCount: { increment: 1 },
			},
		});
		if (reserved.count !== 1) throw limited();
		try {
			// No provider call while holding a DB transaction, and no automatic delivery retry.
			await this.email.sendOtp(recipient, code, randomUUID());
		} catch (error: unknown) {
			await this.prisma.platformMfaChallenge.updateMany({
				where: { id: challenge.id, emailOtpDigest: digest },
				data: { emailOtpDigest: null, emailOtpExpiresAt: null },
			});
			throw error;
		}
		return {
			status: 'sent',
			expiresAt: expiresAt.toISOString(),
			retryAfterSeconds: COOLDOWN_SECONDS,
		};
	}
}

function limited(): HttpException {
	return new HttpException(
		{
			code: 'PLATFORM_EMAIL_RATE_LIMITED',
			message:
				'Wait before requesting another code, or restart sign-in if the send limit was reached.',
		},
		429,
	);
}
