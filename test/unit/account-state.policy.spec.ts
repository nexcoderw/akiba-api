import { UserStatus } from '@nexcoderw/akiba-db';

import {
	accountCanAuthenticate,
	canChangeAccountStatus,
} from '../../src/common/identity/account-state.policy.js';

describe('global identity lifecycle', () => {
	const verified = new Date('2026-01-01');
	it.each(Object.values(UserStatus))('requires active, verified global state: %s', (status) => {
		expect(accountCanAuthenticate(status, verified)).toBe(status === UserStatus.ACTIVE);
		expect(accountCanAuthenticate(status, null)).toBe(false);
	});
	it('requires proof for pending activation and authorized review for reactivation', () => {
		expect(canChangeAccountStatus(UserStatus.PENDING, UserStatus.ACTIVE, null)).toBe(false);
		expect(canChangeAccountStatus(UserStatus.PENDING, UserStatus.ACTIVE, verified)).toBe(false);
		expect(canChangeAccountStatus(UserStatus.ACTIVE, UserStatus.SUSPENDED, verified)).toBe(true);
		expect(canChangeAccountStatus(UserStatus.SUSPENDED, UserStatus.ACTIVE, verified)).toBe(true);
		expect(canChangeAccountStatus(UserStatus.SUSPENDED, UserStatus.ACTIVE, null)).toBe(false);
		expect(canChangeAccountStatus(UserStatus.ACTIVE, UserStatus.DISABLED, verified)).toBe(true);
		for (const next of Object.values(UserStatus)) {
			expect(canChangeAccountStatus(UserStatus.DISABLED, next, verified)).toBe(false);
			expect(canChangeAccountStatus(next, next, verified)).toBe(false);
		}
	});
});
