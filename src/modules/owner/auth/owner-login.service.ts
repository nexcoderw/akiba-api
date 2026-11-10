import {
	Injectable,
	Logger,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import {
	OrganizationMembershipStatus,
	OwnerSessionAssurance,
	PrismaService,
	UserStatus,
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
		this.attempts.assertAllowed(ipAddress, input.email, now.getTime());
		let identity: Awaited<ReturnType<typeof this.readIdentity>>;
		try {
			identity = await this.readIdentity(input.email, organizationSlug);
		} catch (error: unknown) {
			throw this.persistenceFailure(error);
		}
		const passwordHash = identity?.passwordCredential?.passwordHash ?? this.passwords.dummyHash;
		const passwordValid = await this.passwords.verify(passwordHash, input.password);
		const hasOwnerMembership =
			identity?.organizationMemberships.some((membership) =>
				membership.roles.some(({ organizationRole }) => organizationRole.key === 'owner'),
			) ?? false;
		if (
			!passwordValid ||
			identity?.status !== UserStatus.ACTIVE ||
			identity.emailVerifiedAt === null ||
			identity.platformStaff !== null ||
			!hasOwnerMembership
		) {
			this.attempts.recordFailure(ipAddress, input.email, now.getTime());
			this.logger.warn(JSON.stringify({ event: 'owner_login_rejected' }));
			throw new UnauthorizedException(OWNER_AUTH_ERROR.invalidCredentials);
		}

		try {
			const session = await this.sessions.create(identity.id, OwnerSessionAssurance.AAL1, now);
			this.attempts.clearAccount(input.email);
			this.logger.log(JSON.stringify({ event: 'owner_session_created', userId: identity.id }));
			return {
				status: 'authenticated',
				expiresAt: session.expiresAt.toISOString(),
				expiresAtDate: session.expiresAt,
				sessionToken: session.token,
				csrfToken: '',
			};
		} catch (error: unknown) {
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
				passwordCredential: { select: { passwordHash: true } },
				platformStaff: { select: { id: true } },
				organizationMemberships: {
					where: {
						status: OrganizationMembershipStatus.ACTIVE,
						organization: organizationSlug === undefined ? undefined : { slug: organizationSlug },
					},
					select: {
						roles: { select: { organizationRole: { select: { key: true } } } },
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
