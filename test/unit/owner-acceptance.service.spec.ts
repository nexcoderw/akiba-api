import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	OrganizationMembershipStatus,
	OrganizationOwnerEnrollmentStatus,
	OrganizationOwnerInvitationStatus,
	OrganizationStatus,
	PrismaService,
	UserStatus,
} from '@nexcoderw/akiba-db';

import type { OwnerPrincipal } from '../../src/modules/owner/auth/owner-auth.types.js';
import { OwnerTokenService } from '../../src/modules/owner/auth/owner-token.service.js';
import { OwnerAcceptanceService } from '../../src/modules/owner/enrollment/owner-acceptance.service.js';

const NOW = new Date('2026-01-01T00:00:00Z');
const EXPIRES_AT = new Date('2026-01-02T00:00:00Z');
const PRINCIPAL: OwnerPrincipal = {
	sessionId: 'session',
	userId: 'user',
	displayName: 'Example Owner',
	email: 'owner@example.test',
	assurance: 'AAL1',
	expiresAt: EXPIRES_AT,
	organizations: [],
};

describe('OwnerAcceptanceService', () => {
	it.each([1, 0])('consumes proof before acceptance with update count %s', async (count) => {
		const harness = await createHarness({ challengeUpdateCount: count });
		try {
			const result = harness.service.accept(PRINCIPAL, 'token', 'request', NOW);
			if (count === 1) {
				await expect(result).resolves.toMatchObject({ status: 'accepted' });
				expect(harness.writes).toEqual(['consume', 'accept', 'audit']);
			} else {
				await expect(result).rejects.toMatchObject({ status: 401 });
				expect(harness.writes).toEqual(['consume']);
			}
		} finally {
			await harness.module.close();
		}
	});

	it.each([
		{
			name: 'expired challenge',
			change: (challenge: ChallengeFixture) => {
				challenge.expiresAt = NOW;
			},
		},
		{
			name: 'revoked invitation',
			change: (challenge: ChallengeFixture) => {
				challenge.ownerInvitation.status = OrganizationOwnerInvitationStatus.REVOKED;
			},
		},
		{
			name: 'expired invitation',
			change: (challenge: ChallengeFixture) => {
				challenge.ownerInvitation.expiresAt = NOW;
			},
		},
		{
			name: 'mismatched invitation recipient',
			change: (challenge: ChallengeFixture) => {
				challenge.ownerInvitation.invitedEmail = 'another-owner@example.test';
			},
		},
	])('rejects a $name before assigning membership', async ({ change }) => {
		const challenge = challengeFixture();
		change(challenge);
		const harness = await createHarness({ challenge });
		try {
			await expect(
				harness.service.accept(PRINCIPAL, 'token', 'request', NOW),
			).rejects.toMatchObject({ status: 401 });
			expect(harness.transaction.organizationRole.upsert).not.toHaveBeenCalled();
			expect(harness.transaction.organizationMembership.create).not.toHaveBeenCalled();
		} finally {
			await harness.module.close();
		}
	});

	it('rejects an invitation from another organization slug', async () => {
		const harness = await createHarness();
		try {
			await expect(
				harness.service.accept(PRINCIPAL, 'token', 'request', NOW, 'another-organization'),
			).rejects.toMatchObject({ status: 409 });
			expect(harness.transaction.organizationRole.upsert).not.toHaveBeenCalled();
			expect(harness.transaction.organizationMembership.create).not.toHaveBeenCalled();
		} finally {
			await harness.module.close();
		}
	});

	it.each([
		{ name: 'user ID', principal: { ...PRINCIPAL, userId: 'another-user' } },
		{ name: 'email', principal: { ...PRINCIPAL, email: 'another-owner@example.test' } },
	])('rejects a mismatched authenticated $name', async ({ principal }) => {
		const harness = await createHarness();
		try {
			await expect(
				harness.service.accept(principal, 'token', 'request', NOW, 'example-organization'),
			).rejects.toMatchObject({ status: 401 });
			expect(harness.transaction.organizationRole.upsert).not.toHaveBeenCalled();
			expect(harness.transaction.organizationMembership.create).not.toHaveBeenCalled();
		} finally {
			await harness.module.close();
		}
	});

	it.each([OrganizationMembershipStatus.SUSPENDED, OrganizationMembershipStatus.REVOKED])(
		'does not reactivate a restricted %s membership',
		async (membershipStatus) => {
			const harness = await createHarness({ membershipStatus });
			try {
				await expect(
					harness.service.accept(PRINCIPAL, 'token', 'request', NOW, 'example-organization'),
				).rejects.toMatchObject({ status: 409 });
				expect(harness.transaction.organizationMembership.create).not.toHaveBeenCalled();
				expect(harness.transaction.organizationMembership.update).not.toHaveBeenCalled();
				expect(harness.transaction.organizationMembershipRole.upsert).not.toHaveBeenCalled();
			} finally {
				await harness.module.close();
			}
		},
	);

	it('does not assign ownership twice when acceptance is repeated', async () => {
		const challenge = challengeFixture();
		const harness = await createHarness({ challenge });
		harness.transaction.organizationOwnerEnrollmentChallenge.updateMany.mockImplementation(() => {
			harness.writes.push('consume');
			challenge.status = OrganizationOwnerEnrollmentStatus.CONSUMED;
			return Promise.resolve({ count: 1 });
		});
		try {
			await expect(
				harness.service.accept(PRINCIPAL, 'token', 'first-request', NOW, 'example-organization'),
			).resolves.toMatchObject({ status: 'accepted' });
			await expect(
				harness.service.accept(PRINCIPAL, 'token', 'second-request', NOW, 'example-organization'),
			).rejects.toMatchObject({ status: 401 });
			expect(harness.transaction.organizationMembership.create).toHaveBeenCalledTimes(1);
			expect(harness.transaction.organizationMembershipRole.upsert).toHaveBeenCalledTimes(1);
			expect(
				harness.transaction.organizationOwnerAcceptanceAuditEvent.create,
			).toHaveBeenCalledTimes(1);
		} finally {
			await harness.module.close();
		}
	});
});

interface ChallengeFixture {
	id: string;
	organizationId: string;
	ownerInvitationId: string;
	userId: string;
	status: OrganizationOwnerEnrollmentStatus;
	expiresAt: Date;
	user: {
		id: string;
		email: string;
		status: UserStatus;
		emailVerifiedAt: Date;
	};
	ownerInvitation: {
		id: string;
		invitedEmail: string;
		status: OrganizationOwnerInvitationStatus;
		expiresAt: Date;
		tokenDigest: string;
		organization: {
			id: string;
			name: string;
			slug: string;
			status: OrganizationStatus;
		};
	};
}

function challengeFixture(): ChallengeFixture {
	return {
		id: 'challenge',
		organizationId: 'organization',
		ownerInvitationId: 'invitation',
		userId: 'user',
		status: OrganizationOwnerEnrollmentStatus.VERIFIED,
		expiresAt: EXPIRES_AT,
		user: {
			id: 'user',
			email: 'owner@example.test',
			status: UserStatus.ACTIVE,
			emailVerifiedAt: NOW,
		},
		ownerInvitation: {
			id: 'invitation',
			invitedEmail: 'owner@example.test',
			status: OrganizationOwnerInvitationStatus.SENT,
			expiresAt: EXPIRES_AT,
			tokenDigest: 'digest',
			organization: {
				id: 'organization',
				name: 'Example organization',
				slug: 'example-organization',
				status: OrganizationStatus.ACTIVE,
			},
		},
	};
}

async function createHarness(
	options: {
		readonly challenge?: ChallengeFixture;
		readonly challengeUpdateCount?: number;
		readonly membershipStatus?: OrganizationMembershipStatus;
	} = {},
) {
	const writes: string[] = [];
	const challenge = options.challenge ?? challengeFixture();
	const transaction = {
		$queryRaw: jest.fn(() => Promise.resolve([])),
		organizationOwnerEnrollmentChallenge: {
			findUnique: jest.fn().mockImplementation(() => Promise.resolve(challenge)),
			updateMany: jest.fn().mockImplementation(() => {
				writes.push('consume');
				return Promise.resolve({ count: options.challengeUpdateCount ?? 1 });
			}),
		},
		organizationRole: {
			upsert: jest.fn(() =>
				Promise.resolve({
					id: 'role',
					key: 'owner',
					name: 'Owner',
					isSystem: true,
				}),
			),
		},
		organizationMembership: {
			findUnique: jest.fn(() =>
				Promise.resolve(
					options.membershipStatus === undefined
						? null
						: { id: 'membership', status: options.membershipStatus },
				),
			),
			create: jest.fn(() => Promise.resolve({ id: 'membership' })),
			update: jest.fn(() => Promise.resolve({ id: 'membership' })),
		},
		organizationMembershipRole: { upsert: jest.fn(() => Promise.resolve({})) },
		organizationOwnerInvitation: {
			updateMany: jest.fn().mockImplementation(() => {
				writes.push('accept');
				return Promise.resolve({ count: 1 });
			}),
		},
		organizationOwnerAcceptanceAuditEvent: {
			create: jest.fn().mockImplementation(() => {
				writes.push('audit');
				return Promise.resolve({});
			}),
		},
	};
	const module: TestingModule = await Test.createTestingModule({
		providers: [
			OwnerAcceptanceService,
			{
				provide: PrismaService,
				useValue: {
					$transaction: (operation: (client: typeof transaction) => Promise<unknown>) =>
						operation(transaction),
				},
			},
			{
				provide: OwnerTokenService,
				useValue: { isValid: () => true, enrollmentDigest: () => 'digest' },
			},
		],
	}).compile();
	return {
		module,
		service: module.get(OwnerAcceptanceService),
		transaction,
		writes,
	};
}
