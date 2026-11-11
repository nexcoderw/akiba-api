import { randomUUID } from 'node:crypto';

import type { Prisma } from '@nexcoderw/akiba-db';

export type PlatformAuthenticationAction =
	| 'platform_primary_authenticated'
	| 'platform_mfa_rejected'
	| 'platform_session_issued'
	| 'platform_session_revoked'
	| 'platform_challenge_revoked';

/** Commit security facts with their state change; never include credentials or arbitrary metadata. */
export async function recordPlatformAuthentication(
	transaction: Prisma.TransactionClient,
	user: { readonly id: string; readonly identityVersion: number },
	action: PlatformAuthenticationAction,
	requestId?: string,
): Promise<void> {
	const operationId =
		requestId !== undefined && /^req_[0-9a-f-]{36}$/u.test(requestId)
			? requestId
			: `req_${randomUUID()}`;
	await transaction.identitySecurityAuditEvent.create({
		data: {
			userId: user.id,
			actorUserId: user.id,
			actorKind: 'authentication',
			action,
			identityVersion: user.identityVersion,
			requestId: operationId,
		},
		select: { id: true },
	});
}
