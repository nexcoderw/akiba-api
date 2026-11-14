import type { Prisma } from '@nexcoderw/akiba-db';

import type { PlatformTokenService } from './platform-token.service.js';

/** Legacy verifiers remain scoped to their current generation; newly issued codes use v2. */
export async function consumePlatformRecoveryCode(
	transaction: Prisma.TransactionClient,
	tokens: PlatformTokenService,
	staffId: string,
	generation: number,
	code: string,
	now: Date,
): Promise<boolean> {
	if (code.length > 64) return false;
	const normalized = code.trim().toUpperCase();
	if (!/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/u.test(normalized)) return false;
	const result = await transaction.platformRecoveryCode.updateMany({
		where: {
			platformStaffId: staffId,
			generation,
			usedAt: null,
			OR: [
				{ digestVersion: 2, codeDigest: tokens.recoveryCodeDigest(normalized) },
				{ digestVersion: 1, codeDigest: tokens.digest(normalized) },
			],
		},
		data: { usedAt: now },
	});
	return result.count === 1;
}
