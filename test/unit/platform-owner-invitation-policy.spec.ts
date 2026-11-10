import { OrganizationOwnerInvitationStatus, OrganizationStatus } from '@nexcoderw/akiba-db';

import {
	assertOrganizationCanReceiveOwnerInvitation,
	assertOwnerInvitationCanBeRevoked,
} from '../../src/modules/platform/owner-onboarding/platform-owner-invitation-policy.js';

describe('owner invitation transition policy', () => {
	it.each([OrganizationStatus.PENDING, OrganizationStatus.ACTIVE])(
		'allows invitations for %s organizations',
		(status) => {
			expect(() => {
				assertOrganizationCanReceiveOwnerInvitation(status);
			}).not.toThrow();
		},
	);
	it.each([OrganizationStatus.SUSPENDED, OrganizationStatus.ARCHIVED])(
		'rejects invitations for %s organizations',
		(status) => {
			expect(() => {
				assertOrganizationCanReceiveOwnerInvitation(status);
			}).toThrow();
		},
	);
	it.each([
		OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
		OrganizationOwnerInvitationStatus.SENT,
	])('allows revocation from %s', (status) => {
		expect(() => {
			assertOwnerInvitationCanBeRevoked(status);
		}).not.toThrow();
	});
	it.each([OrganizationOwnerInvitationStatus.ACCEPTED, OrganizationOwnerInvitationStatus.REVOKED])(
		'rejects revocation from terminal state %s',
		(status) => {
			expect(() => {
				assertOwnerInvitationCanBeRevoked(status);
			}).toThrow();
		},
	);
});
