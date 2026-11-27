import { normalizeEmailIdentity } from '../../../common/identity/email-identity.js';
import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import {
	Injectable,
	Logger,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import {
	OrganizationMembershipStatus,
	OrganizationStatus,
	OwnerSessionAssurance,
	PrismaService,
} from '@nexcoderw/akiba-db';

import type { OwnerAuthenticatedResponseDto } from './dto/owner-auth-response.dto.js';
import type { OwnerLoginDto } from './dto/owner-login.dto.js';
import { OWNER_AUTH_ERROR } from './owner-auth.constants.js';
import { OwnerEmailOtpService } from './owner-email-otp.service.js';
import { OwnerLoginAttemptService } from './owner-login-attempt.service.js';
import { OwnerSessionService } from './owner-session.service.js';
import { PlatformPasswordService } from '../../platform/auth/platform-password.service.js';

export interface OwnerLoginSuccess extends OwnerAuthenticatedResponseDto {
	readonly sessionToken: string;
	readonly expiresAtDate: Date;
}

@Injectable()
export class OwnerLoginService {
	private readonly logger = new Logger(OwnerLoginService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly passwords: PlatformPasswordService,
		private readonly attempts: OwnerLoginAttemptService,
		private readonly sessions: OwnerSessionService,
		private readonly otp: OwnerEmailOtpService,
	) {}

	async login(
		input: OwnerLoginDto,
		ipAddress: string,
		now = new Date(),
		organizationSlug?: string,
		origin = '',
	) {
		this.otp.assertEnabled();
		const email = normalizeEmailIdentity(input.email);
		if (email === null) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidCredentials);
		this.attempts.consume(ipAddress, email, now.getTime());
		let identity: Awaited<ReturnType<typeof this.readIdentity>>;
		try {
			identity = await this.readIdentity(email, organizationSlug);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}
		const passwordHash = identity?.passwordCredential?.passwordHash ?? this.passwords.dummyHash;
		const passwordValid = await this.passwords.verify(
			passwordHash,
			input.password,
			identity?.passwordCredential?.normalization ?? 'raw',
		);
		const ownerMemberships =
			identity?.organizationMemberships.filter((membership) =>
				membership.roles.some(
					({ organizationRole }) =>
						organizationRole.key === 'owner' &&
						organizationRole.isSystem &&
						organizationRole.isActive,
				),
			) ?? [];
		const membership = ownerMemberships.length === 1 ? ownerMemberships[0] : undefined;
		if (identity === null || ownerMemberships.length === 0) {
			throw new ApiProblemException('OWNER_ACCOUNT_NOT_FOUND');
		}
		if (
			!passwordValid ||
			!accountCanAuthenticate(identity.status, identity.emailVerifiedAt) ||
			identity.passwordCredential?.disabledAt !== null ||
			identity.platformStaff !== null ||
			membership === undefined
		) {
			this.logger.warn(JSON.stringify({ event: 'owner_login_rejected' }));
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidCredentials);
		}

		return this.otp.send(
			{
				userId: identity.id,
				organizationId: membership.organizationId,
				recipient: identity.email,
				identityVersion: identity.identityVersion,
				credentialVersion: identity.passwordCredential.version,
			},
			{ purpose: 'login', membershipId: membership.id },
			origin,
		);
	}

	async verifyEmailOtp(token: string, code: string, origin: string): Promise<OwnerLoginSuccess> {
		const proof = await this.otp.consume(token, code, origin, 'login');
		if (proof.membershipId === null) throw new ApiProblemException('AUTH_MFA_INVALID');
		const session = await this.sessions.create(
			proof.userId,
			{ organizationId: proof.organizationId, membershipId: proof.membershipId },
			OwnerSessionAssurance.PASSWORD_EMAIL_OTP,
			new Date(),
			proof,
		);
		return {
			status: 'authenticated',
			expiresAt: session.expiresAt.toISOString(),
			expiresAtDate: session.expiresAt,
			sessionToken: session.token,
			csrfToken: '',
		};
	}

	private readIdentity(email: string, organizationSlug?: string) {
		return this.prisma.user.findUnique({
			where: { email },
			select: {
				id: true,
				email: true,
				identityVersion: true,
				status: true,
				emailVerifiedAt: true,
				passwordCredential: {
					select: { passwordHash: true, normalization: true, disabledAt: true, version: true },
				},
				platformStaff: { select: { id: true } },
				organizationMemberships: {
					where: {
						status: OrganizationMembershipStatus.ACTIVE,
						organization: {
							status: OrganizationStatus.ACTIVE,
							...(organizationSlug === undefined ? {} : { slug: organizationSlug }),
						},
					},
					select: {
						id: true,
						organizationId: true,
						roles: {
							select: {
								organizationRole: { select: { key: true, isSystem: true, isActive: true } },
							},
						},
					},
				},
			},
		});
	}

	private persistenceFailure(error: unknown): ServiceUnavailableException {
		return new ServiceUnavailableException(
			{
				code: 'OWNER_LOGIN_UNAVAILABLE',
				message: 'Sign-in is temporarily unavailable. Try again.',
			},
			{ cause: error },
		);
	}
}
