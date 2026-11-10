import { UserStatus } from '@nexcoderw/akiba-db';

/** Memberships and staff records never override the global identity's eligibility. */
export function accountCanAuthenticate(status: UserStatus, emailVerifiedAt: Date | null): boolean {
	return status === UserStatus.ACTIVE && emailVerifiedAt !== null;
}

export function accountCanProvisionCredentials(status: UserStatus): boolean {
	return status === UserStatus.PENDING || status === UserStatus.ACTIVE;
}

/** Pending activation requires mailbox proof; disabled accounts have no implicit restoration path. */
export function canChangeAccountStatus(
	current: UserStatus,
	next: UserStatus,
	emailVerifiedAt: Date | null,
): boolean {
	if (current === next || current === UserStatus.DISABLED) return false;
	if (next === UserStatus.DISABLED) return true;
	if (current === UserStatus.ACTIVE && next === UserStatus.SUSPENDED) return true;
	return current === UserStatus.SUSPENDED && next === UserStatus.ACTIVE && emailVerifiedAt !== null;
}
