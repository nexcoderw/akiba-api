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
	) {}

	async login(
		input: OwnerLoginDto,
		ipAddress: string,
		now = new Date(),
		organizationSlug?: string,
	): Promise<OwnerLoginSuccess> {
		const email = normalizeEmailIdentity(input.email);
		if (email === null) throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidCredentials);
		this.attempts.assertAllowed(ipAddress, email, now.getTime());
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
		if (
			!passwordValid ||
			identity === null ||
			!accountCanAuthenticate(identity.status, identity.emailVerifiedAt) ||
			identity.passwordCredential?.disabledAt !== null ||
			identity.platformStaff !== null ||
			membership === undefined
		) {
			this.attempts.recordFailure(ipAddress, email, now.getTime());
			this.logger.warn(JSON.stringify({ event: 'owner_login_rejected' }));
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidCredentials);
		}

		try {
			const session = await this.sessions.create(
				identity.id,
				{ organizationId: membership.organizationId, membershipId: membership.id },
				OwnerSessionAssurance.AAL1,
				now,
			);
			this.attempts.clearAccount(email);
			this.logger.log(JSON.stringify({ event: 'owner_session_created', userId: identity.id }));
			return {
				status: 'authenticated',
				expiresAt: session.expiresAt.toISOString(),
				expiresAtDate: session.expiresAt,
				sessionToken: session.token,
				csrfToken: '',
			};
		} catch (error: unknown) {
			if (error instanceof UnauthorizedException)
				throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidCredentials);
			if (error instanceof ApiProblemException) throw error;
			throw this.persistenceFailure(error);
		}
	}

	private readIdentity(email: string, organizationSlug?: string) {
		return this.prisma.user.findUnique({
			where: { email },
			select: {
				id: true,
				status: true,
				emailVerifiedAt: true,
				passwordCredential: {
					select: { passwordHash: true, normalization: true, disabledAt: true },
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
