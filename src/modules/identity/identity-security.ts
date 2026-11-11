import { isUUID } from 'class-validator';
import { OrganizationOwnerEnrollmentStatus, type Prisma } from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../common/errors/api-problem.exception.js';
import type { PlatformPrincipal } from '../platform/auth/platform-auth.types.js';
import { PLATFORM_PERMISSION } from '../platform/auth/platform-permission.constants.js';
import type { PlatformSessionService } from '../platform/auth/platform-session.service.js';

export const IDENTITY_TRANSACTION = Object.freeze({ maxWait: 5000, timeout: 10_000 });
export interface IdentityOperationContext {
	readonly principal: PlatformPrincipal | undefined;
	readonly requestId: string;
}
export type IdentityAuditAction =
	| 'identity_created'
	| 'email_verified'
	| 'email_changed'
	| 'password_created'
	| 'password_changed'
	| 'password_rehashed'
	| 'credential_disabled'
	| 'account_suspended'
	| 'account_reactivated'
	| 'account_disabled'
	| 'credential_compromised';
export type IdentityAuditActor =
	| {
			readonly actorKind: 'platform' | 'bootstrap';
			readonly actorPlatformStaffId: string;
			readonly requestId: string;
	  }
	| {
			readonly actorKind: 'enrollment' | 'email_verification';
			readonly actorUserId: string;
			readonly requestId: string;
	  };

export async function authorizeIdentityOperation(
	sessions: PlatformSessionService,
	context: IdentityOperationContext,
): Promise<IdentityAuditActor> {
	const { principal, requestId } = context;
	await sessions.authorize(principal, PLATFORM_PERMISSION.identitiesManage);
	if (principal === undefined || !/^req_[0-9a-f-]{36}$/u.test(requestId)) {
		throw new ApiProblemException('ACCESS_DENIED');
	}
	return Object.freeze({
		actorKind: 'platform',
		actorPlatformStaffId: principal.platformStaffId,
		requestId,
	});
}

export function assertIdentityTarget(userId: string, version: number): void {
	if (!isUUID(userId) || !Number.isSafeInteger(version) || version < 1) {
		throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
	}
}

/** Lock identities before their credentials, proofs and session state in every mutating workflow. */
export async function lockIdentity(
	transaction: Prisma.TransactionClient,
	userId: string,
): Promise<Date> {
	const [row] = await transaction.$queryRaw<{ now: Date }[]>`
		SELECT clock_timestamp() AS now FROM public.users WHERE id = ${userId}::uuid FOR UPDATE
	`;
	if (row === undefined) throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
	return row.now;
}

export async function recordIdentityEvent(
	transaction: Prisma.TransactionClient,
	actor: IdentityAuditActor,
	event: {
		readonly userId: string;
		readonly action: IdentityAuditAction;
		readonly identityVersion: number;
		readonly credentialVersion?: number;
	},
): Promise<void> {
	await transaction.identitySecurityAuditEvent.create({
		data: { ...actor, ...event },
		select: { id: true },
	});
}

/** Must commit with the corresponding account/credential change. A failed hook rolls it all back. */
export async function revokeIdentityAuthentication(
	transaction: Prisma.TransactionClient,
	userId: string,
	now: Date,
): Promise<void> {
	await transaction.ownerSession.updateMany({
		where: { userId, revokedAt: null },
		data: { revokedAt: now, revocationReason: 'credential_change' },
	});
	await transaction.platformAdminSession.updateMany({
		where: { platformStaff: { userId }, revokedAt: null },
		data: { revokedAt: now, revocationReason: 'credential_change' },
	});
	await transaction.platformMfaChallenge.updateMany({
		where: { platformStaff: { userId }, consumedAt: null },
		data: { consumedAt: now },
	});
	await transaction.organizationOwnerEnrollmentChallenge.updateMany({
		where: {
			userId,
			status: {
				in: [OrganizationOwnerEnrollmentStatus.PENDING, OrganizationOwnerEnrollmentStatus.VERIFIED],
			},
		},
		data: {
			status: OrganizationOwnerEnrollmentStatus.REVOKED,
			tokenDigest: null,
			revokedAt: now,
			updatedAt: now,
		},
	});
	await transaction.userEmailVerificationChallenge.updateMany({
		where: { userId, consumedAt: null },
		data: { consumedAt: now },
	});
}

export function identityFailure(error: unknown): ApiProblemException {
	return error instanceof ApiProblemException
		? error
		: new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE', [], error);
}
