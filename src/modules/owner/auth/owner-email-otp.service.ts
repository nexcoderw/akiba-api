import { randomInt, randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { ResendEmailService } from '../../../infrastructure/email/resend-email.service.js';
import type { OwnerPrincipal } from './owner-auth.types.js';
import { OwnerTokenService } from './owner-token.service.js';

type Scope =
	| { purpose: 'login'; membershipId: string }
	| { purpose: 'enrollment'; enrollmentChallengeId: string };

interface Identity {
	userId: string;
	organizationId: string;
	recipient: string;
	identityVersion: number;
	credentialVersion: number;
}

const lifetime = 300_000;
const cooldown = 60_000;
const attemptLimit = 5;

@Injectable()
export class OwnerEmailOtpService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly tokens: OwnerTokenService,
		private readonly email: ResendEmailService,
	) {}

	assertEnabled(): void {
		if (!this.config.get('OWNER_AUTH_EMAIL_OTP_ENABLED', { infer: true })) {
			throw new ApiProblemException('SERVICE_UNAVAILABLE');
		}
	}

	async send(identity: Identity, scope: Scope, origin: string, now = new Date()) {
		this.assertEnabled();
		const token = this.tokens.create();
		const code = randomInt(1_000_000).toString().padStart(6, '0');
		const id = randomUUID();
		const expiresAt = new Date(now.getTime() + lifetime);
		const { organizationId, userId, identityVersion, credentialVersion } = identity;
		const key = { organizationId, userId, purpose: scope.purpose };
		const data = {
			id,
			...key,
			origin,
			identityVersion,
			credentialVersion,
			membershipId: scope.purpose === 'login' ? scope.membershipId : null,
			enrollmentChallengeId: scope.purpose === 'enrollment' ? scope.enrollmentChallengeId : null,
			tokenDigest: this.tokens.emailOtpDigest(token),
			codeDigest: this.tokens.emailOtpDigest(token, code),
			createdAt: now,
			expiresAt,
			attempts: 0,
			sentAt: null,
			consumedAt: null,
		};
		await this.prisma.$transaction(async (tx) => {
			// One issuer at a time for the same identity, including across API processes.
			await tx.$queryRaw`SELECT id FROM public.users WHERE id = ${userId}::uuid FOR UPDATE`;
			const current = await tx.user.findFirst({
				where: {
					id: userId,
					email: identity.recipient,
					identityVersion,
					status: 'ACTIVE',
					emailVerifiedAt: { not: null },
					platformStaff: null,
					passwordCredential: { is: { version: credentialVersion, disabledAt: null } },
				},
				select: { id: true },
			});
			if (!current) throw invalidCode();
			const previous = await tx.ownerEmailOtpChallenge.findUnique({
				where: { organizationId_userId_purpose: key },
				select: { createdAt: true },
			});
			if (previous && now.getTime() - previous.createdAt.getTime() < cooldown) {
				throw new ApiProblemException('RATE_LIMITED');
			}
			await tx.ownerEmailOtpChallenge.upsert({
				where: { organizationId_userId_purpose: key },
				create: data,
				update: data,
			});
		});
		await this.email.sendOrganizationOtp(identity.recipient, code, id);
		const sentAt = new Date();
		const marked = await this.prisma.ownerEmailOtpChallenge.updateMany({
			where: { id, expiresAt: { gt: sentAt } },
			data: { sentAt },
		});
		if (marked.count !== 1) throw invalidCode();
		return { status: 'email_otp_required' as const, token, expiresAt: expiresAt.toISOString() };
	}

	async sendEnrollment(principal: OwnerPrincipal, origin: string, organizationSlug?: string) {
		this.assertEnabled();
		if (principal.enrollmentChallengeId === undefined) throw invalidCode();
		const now = new Date();
		const challenge = await this.prisma.organizationOwnerEnrollmentChallenge.findFirst({
			where: {
				id: principal.enrollmentChallengeId,
				userId: principal.userId,
				status: 'VERIFIED',
				expiresAt: { gt: now },
				ownerInvitation: { status: 'SENT', expiresAt: { gt: now } },
				...(organizationSlug === undefined ? {} : { organization: { slug: organizationSlug } }),
			},
			select: {
				id: true,
				organizationId: true,
				user: {
					select: {
						email: true,
						identityVersion: true,
						passwordCredential: { select: { version: true } },
					},
				},
			},
		});
		if (!challenge?.user?.passwordCredential) throw invalidCode();
		return this.send(
			{
				userId: principal.userId,
				organizationId: challenge.organizationId,
				recipient: challenge.user.email,
				identityVersion: challenge.user.identityVersion,
				credentialVersion: challenge.user.passwordCredential.version,
			},
			{ purpose: 'enrollment', enrollmentChallengeId: challenge.id },
			origin,
		);
	}

	async consume(
		token: string,
		code: string,
		origin: string,
		purpose: Scope['purpose'],
		enrollment?: { userId: string; challengeId: string },
	) {
		this.assertEnabled();
		if (!this.tokens.isValid(token) || !/^\d{6}$/u.test(code)) throw invalidCode();
		const result = await this.prisma.$transaction(async (tx) => {
			const tokenDigest = this.tokens.emailOtpDigest(token);
			const rows = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM public.owner_email_otp_challenges
				WHERE token_digest = ${tokenDigest} AND origin = ${origin} AND purpose = ${purpose}
				FOR UPDATE
			`;
			if (!rows[0]) return null;
			const now = new Date();
			const challenge = await tx.ownerEmailOtpChallenge.findUnique({
				where: { id: rows[0].id },
				include: {
					user: {
						select: {
							identityVersion: true,
							status: true,
							emailVerifiedAt: true,
							platformStaff: { select: { id: true } },
							passwordCredential: { select: { version: true, disabledAt: true } },
						},
					},
				},
			});
			if (
				!challenge?.sentAt ||
				challenge.expiresAt <= now ||
				challenge.consumedAt ||
				challenge.attempts >= attemptLimit ||
				challenge.user.status !== 'ACTIVE' ||
				challenge.user.emailVerifiedAt === null ||
				challenge.user.platformStaff !== null ||
				challenge.user.identityVersion !== challenge.identityVersion ||
				challenge.user.passwordCredential?.version !== challenge.credentialVersion ||
				challenge.user.passwordCredential.disabledAt !== null ||
				(enrollment &&
					(challenge.userId !== enrollment.userId ||
						challenge.enrollmentChallengeId !== enrollment.challengeId))
			)
				return null;
			const valid = this.tokens.equal(
				this.tokens.emailOtpDigest(token, code),
				challenge.codeDigest,
			);
			await tx.ownerEmailOtpChallenge.update({
				where: { id: challenge.id },
				data: valid ? { consumedAt: now } : { attempts: { increment: 1 } },
			});
			return valid
				? {
						id: challenge.id,
						userId: challenge.userId,
						organizationId: challenge.organizationId,
						membershipId: challenge.membershipId,
						identityVersion: challenge.identityVersion,
						credentialVersion: challenge.credentialVersion,
						verifiedAt: now,
					}
				: null;
		});
		if (!result) throw invalidCode();
		return result;
	}
}

function invalidCode() {
	return new UnauthorizedException({
		code: 'AUTH_MFA_INVALID',
		message: 'The email code is invalid or has expired.',
	});
}
