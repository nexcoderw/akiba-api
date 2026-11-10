import { randomUUID } from 'node:crypto';
import { normalizeEmailIdentity } from '../../../common/identity/email-identity.js';
import { recordIdentityEvent } from '../../identity/identity-security.js';
import { accountCanAuthenticate } from '../../../common/identity/account-state.policy.js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	OrganizationOwnerEnrollmentPurpose,
	OrganizationOwnerEnrollmentStatus,
	OrganizationOwnerInvitationStatus,
	OrganizationStatus,
	OwnerSessionAssurance,
	Prisma,
	PrismaService,
	UserStatus,
} from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { PlatformPasswordService } from '../../platform/auth/platform-password.service.js';
import { acceptsBootstrapPassword } from '../../platform/auth/platform-password-policy.js';
import { OwnerSessionService } from '../auth/owner-session.service.js';
import { OwnerTokenService } from '../auth/owner-token.service.js';
import { OwnerInvitationTokenService } from '../../platform/owner-onboarding/owner-invitation-token.service.js';
import type {
	RegisterInvitedOwnerDto,
	VerifyExistingOwnerDto,
} from './dto/owner-enrollment.dto.js';
import type {
	OwnerEnrollmentAuthenticatedResponseDto,
	OwnerEnrollmentChallengeResponseDto,
} from './dto/owner-enrollment-response.dto.js';
import {
	invalidOwnerEnrollment,
	ownerEnrollmentConflict,
	ownerEnrollmentFailure,
} from './owner-enrollment-errors.js';

const TRANSACTION_OPTIONS = Object.freeze({
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 10_000,
	timeout: 15_000,
});

export interface VerifiedOwnerEnrollment extends OwnerEnrollmentAuthenticatedResponseDto {
	readonly sessionToken: string;
	readonly expiresAtDate: Date;
}

@Injectable()
export class OwnerEnrollmentService {
	private readonly logger = new Logger(OwnerEnrollmentService.name);
	private readonly challengeLifetimeMilliseconds: number;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly invitationTokens: OwnerInvitationTokenService,
		private readonly ownerTokens: OwnerTokenService,
		private readonly passwords: PlatformPasswordService,
		private readonly sessions: OwnerSessionService,
	) {
		this.challengeLifetimeMilliseconds =
			config.get('OWNER_ENROLLMENT_CHALLENGE_TTL_SECONDS', { infer: true }) * 1000;
	}

	async start(
		invitationToken: string,
		now = new Date(),
		organizationSlug?: string,
	): Promise<OwnerEnrollmentChallengeResponseDto> {
		if (!this.invitationTokens.isValidFormat(invitationToken)) throw invalidOwnerEnrollment();
		const challengeToken = this.ownerTokens.create();
		const expiresAt = new Date(now.getTime() + this.challengeLifetimeMilliseconds);
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const invitation = await transaction.organizationOwnerInvitation.findUnique({
					where: { tokenDigest: this.invitationTokens.digest(invitationToken) },
					select: {
						id: true,
						organizationId: true,
						invitedEmail: true,
						status: true,
						expiresAt: true,
						revokedAt: true,
						acceptedAt: true,
						organization: { select: { name: true, slug: true, status: true } },
					},
				});
				if (
					invitation?.status !== OrganizationOwnerInvitationStatus.SENT ||
					invitation.expiresAt === null ||
					invitation.expiresAt <= now ||
					invitation.revokedAt !== null ||
					invitation.acceptedAt !== null ||
					(organizationSlug !== undefined && invitation.organization.slug !== organizationSlug) ||
					(invitation.organization.status !== OrganizationStatus.PENDING &&
						invitation.organization.status !== OrganizationStatus.ACTIVE)
				) {
					throw invalidOwnerEnrollment();
				}

				const identity = await transaction.user.findUnique({
					where: { email: invitation.invitedEmail },
					select: { id: true },
				});
				await transaction.organizationOwnerEnrollmentChallenge.updateMany({
					where: {
						organizationId: invitation.organizationId,
						ownerInvitationId: invitation.id,
						status: {
							in: [
								OrganizationOwnerEnrollmentStatus.PENDING,
								OrganizationOwnerEnrollmentStatus.VERIFIED,
							],
						},
					},
					data: {
						status: OrganizationOwnerEnrollmentStatus.REVOKED,
						tokenDigest: null,
						revokedAt: now,
						updatedAt: now,
					},
				});
				const purpose =
					identity === null
						? OrganizationOwnerEnrollmentPurpose.NEW_USER_ENROLLMENT
						: OrganizationOwnerEnrollmentPurpose.EXISTING_USER_AUTHENTICATION;
				await transaction.organizationOwnerEnrollmentChallenge.create({
					data: {
						organizationId: invitation.organizationId,
						ownerInvitationId: invitation.id,
						userId: identity?.id,
						purpose,
						status: OrganizationOwnerEnrollmentStatus.PENDING,
						tokenDigest: this.ownerTokens.enrollmentDigest(challengeToken),
						createdAt: now,
						updatedAt: now,
						expiresAt,
					},
				});
				return {
					nextStep: identity === null ? ('register' as const) : ('sign_in' as const),
					challengeToken,
					expiresAt: expiresAt.toISOString(),
					organizationName: invitation.organization.name,
					organizationStatus: invitation.organization.status,
				};
			}, TRANSACTION_OPTIONS);
		} catch (error: unknown) {
			throw ownerEnrollmentFailure(error);
		}
	}

	async verifyExisting(
		input: VerifyExistingOwnerDto,
		now = new Date(),
		organizationSlug?: string,
	): Promise<VerifiedOwnerEnrollment> {
		const challenge = await this.readChallenge(input.challengeToken, now);
		if (
			(organizationSlug !== undefined &&
				challenge.ownerInvitation.organization.slug !== organizationSlug) ||
			challenge.purpose !== OrganizationOwnerEnrollmentPurpose.EXISTING_USER_AUTHENTICATION ||
			challenge.user === null
		) {
			throw invalidOwnerEnrollment();
		}
		const passwordHash =
			challenge.user.passwordCredential?.passwordHash ?? this.passwords.dummyHash;
		const valid = await this.passwords.verify(
			passwordHash,
			input.password,
			challenge.user.passwordCredential?.normalization ?? 'raw',
		);
		if (
			!valid ||
			!accountCanAuthenticate(challenge.user.status, challenge.user.emailVerifiedAt) ||
			challenge.user.passwordCredential?.disabledAt !== null ||
			challenge.user.platformStaff !== null
		) {
			await this.recordFailure(challenge.id, now);
			throw invalidOwnerEnrollment();
		}
		try {
			if (challenge.status === OrganizationOwnerEnrollmentStatus.PENDING) {
				const updated = await this.prisma.organizationOwnerEnrollmentChallenge.updateMany({
					where: {
						id: challenge.id,
						status: OrganizationOwnerEnrollmentStatus.PENDING,
						expiresAt: { gt: now },
						failedAttempts: { lt: challenge.maxAttempts },
					},
					data: {
						status: OrganizationOwnerEnrollmentStatus.VERIFIED,
						mailboxVerifiedAt: now,
						authenticatedAt: now,
						verifiedAt: now,
						updatedAt: now,
					},
				});
				if (updated.count !== 1) throw invalidOwnerEnrollment();
			}
			return await this.createAuthenticatedResult(challenge.user.id, now);
		} catch (error: unknown) {
			throw ownerEnrollmentFailure(error);
		}
	}

	async register(
		input: RegisterInvitedOwnerDto,
		now = new Date(),
		organizationSlug?: string,
		auditRequestId?: string,
	): Promise<VerifiedOwnerEnrollment> {
		const challenge = await this.readChallenge(input.challengeToken, now);
		if (
			(organizationSlug !== undefined &&
				challenge.ownerInvitation.organization.slug !== organizationSlug) ||
			challenge.purpose !== OrganizationOwnerEnrollmentPurpose.NEW_USER_ENROLLMENT ||
			challenge.user !== null ||
			challenge.status !== OrganizationOwnerEnrollmentStatus.PENDING
		) {
			throw invalidOwnerEnrollment();
		}
		const requestId = auditRequestId ?? `req_${randomUUID()}`;
		const invitedEmail = normalizeEmailIdentity(challenge.ownerInvitation.invitedEmail);
		if (invitedEmail === null || !/^req_[0-9a-f-]{36}$/u.test(requestId))
			throw invalidOwnerEnrollment();
		const password = Buffer.from(input.password, 'utf8');
		let phase: 'password_hash' | 'identity_transaction' | 'session_creation' = 'password_hash';
		try {
			if (!acceptsBootstrapPassword(password, challenge.ownerInvitation.invitedEmail)) {
				throw ownerEnrollmentConflict('Choose a stronger password of at least 15 characters.');
			}
			const passwordHash = await this.passwords.hash(password);
			phase = 'identity_transaction';
			const userId = await this.prisma.$transaction(async (transaction) => {
				const user = await transaction.user.create({
					data: {
						email: invitedEmail,
						displayName: input.displayName,
						status: UserStatus.ACTIVE,
						emailVerifiedAt: now,
						passwordCredential: {
							create: { passwordHash, normalization: 'nfc', passwordChangedAt: now },
						},
					},
					select: { id: true, identityVersion: true },
				});
				const verified = await transaction.organizationOwnerEnrollmentChallenge.updateMany({
					where: {
						id: challenge.id,
						status: OrganizationOwnerEnrollmentStatus.PENDING,
						userId: null,
						expiresAt: { gt: now },
					},
					data: {
						userId: user.id,
						status: OrganizationOwnerEnrollmentStatus.VERIFIED,
						mailboxVerifiedAt: now,
						authenticatedAt: now,
						verifiedAt: now,
						updatedAt: now,
					},
				});
				if (verified.count !== 1) throw invalidOwnerEnrollment();
				const actor = { actorKind: 'enrollment' as const, actorUserId: user.id, requestId };
				for (const action of ['identity_created', 'email_verified', 'password_created'] as const) {
					await recordIdentityEvent(transaction, actor, {
						userId: user.id,
						action,
						identityVersion: user.identityVersion,
						...(action === 'password_created' ? { credentialVersion: 1 } : {}),
					});
				}
				return user.id;
			}, TRANSACTION_OPTIONS);
			phase = 'session_creation';
			return await this.createAuthenticatedResult(userId, now);
		} catch (error: unknown) {
			// Classify locally; never log exception messages, credentials or submitted identity fields.
			const errorKind =
				error instanceof TypeError
					? 'type_error'
					: error instanceof RangeError
						? 'range_error'
						: 'operation_error';
			this.logger.error({ code: 'OWNER_REGISTRATION_FAILED', phase, errorKind });
			throw ownerEnrollmentFailure(error);
		} finally {
			password.fill(0);
		}
	}

	private async readChallenge(token: string, now: Date) {
		if (!this.ownerTokens.isValid(token)) throw invalidOwnerEnrollment();
		try {
			const challenge = await this.prisma.organizationOwnerEnrollmentChallenge.findUnique({
				where: { tokenDigest: this.ownerTokens.enrollmentDigest(token) },
				select: {
					id: true,
					purpose: true,
					status: true,
					expiresAt: true,
					failedAttempts: true,
					maxAttempts: true,
					ownerInvitation: {
						select: { invitedEmail: true, organization: { select: { slug: true } } },
					},
					user: {
						select: {
							id: true,
							status: true,
							emailVerifiedAt: true,
							platformStaff: { select: { id: true } },
							passwordCredential: {
								select: { passwordHash: true, normalization: true, disabledAt: true },
							},
						},
					},
				},
			});
			if (
				challenge === null ||
				(challenge.status !== OrganizationOwnerEnrollmentStatus.PENDING &&
					challenge.status !== OrganizationOwnerEnrollmentStatus.VERIFIED) ||
				challenge.expiresAt <= now ||
				challenge.failedAttempts >= challenge.maxAttempts
			) {
				throw invalidOwnerEnrollment();
			}
			return challenge;
		} catch (error: unknown) {
			throw ownerEnrollmentFailure(error);
		}
	}

	private async recordFailure(challengeId: string, now: Date): Promise<void> {
		await this.prisma.organizationOwnerEnrollmentChallenge.updateMany({
			where: {
				id: challengeId,
				status: OrganizationOwnerEnrollmentStatus.PENDING,
				expiresAt: { gt: now },
				failedAttempts: { lt: 10 },
			},
			data: { failedAttempts: { increment: 1 }, updatedAt: now },
		});
	}

	private async createAuthenticatedResult(
		userId: string,
		now: Date,
	): Promise<VerifiedOwnerEnrollment> {
		const session = await this.sessions.create(userId, OwnerSessionAssurance.AAL1, now);
		return {
			status: 'verified',
			expiresAt: session.expiresAt.toISOString(),
			expiresAtDate: session.expiresAt,
			sessionToken: session.token,
			csrfToken: '',
		};
	}
}
