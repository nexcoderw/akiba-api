import { jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
	OrganizationOwnerInvitationDeliveryStatus as DeliveryStatus,
	OrganizationOwnerInvitationStatus as InvitationStatus,
	PlatformStaffStatus,
	PrismaService,
} from '@nexcoderw/akiba-db';

import {
	ResendOwnerInvitationEmailService,
	type InvitationProviderOutcome,
} from '../../src/infrastructure/email/resend-owner-invitation-email.service.js';
import { OwnerInvitationDeliveryGate } from '../../src/modules/platform/owner-onboarding/owner-invitation-delivery.policy.js';
import {
	OwnerInvitationDeliveryService,
	deliveryResponse,
} from '../../src/modules/platform/owner-onboarding/owner-invitation-delivery.service.js';
import { OwnerInvitationDeliveryWorkerService } from '../../src/modules/platform/owner-onboarding/owner-invitation-delivery-worker.service.js';
import { OwnerInvitationTokenService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token.service.js';
import { OwnerInvitationTokenEnvelopeService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token-envelope.service.js';
import {
	DurableOwnerInvitationAudit,
	PlatformOwnerInvitationAudit,
} from '../../src/modules/platform/owner-onboarding/platform-owner-invitation-audit.js';
import {
	createInvitationDeliveryDatabaseFixture,
	invitationDeliveryConfig,
	invitationDeliveryInput,
} from '../fixtures/owner-invitation-delivery.fixture.js';
import {
	OWNER_INVITATION_ACTOR_ID,
	OWNER_INVITATION_ID,
} from '../fixtures/platform-owner-onboarding-database.fixture.js';
import { ORGANIZATION_ID } from '../fixtures/platform-organizations-database.fixture.js';

import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformServiceAuthModule } from '../fixtures/platform-service-auth.module.js';

const context = {
	actorPlatformStaffId: OWNER_INVITATION_ACTOR_ID,
	requestId: 'fictional-delivery-request',
};

async function setup(input = invitationDeliveryInput()) {
	const database = createInvitationDeliveryDatabaseFixture();
	const config = invitationDeliveryConfig(input);
	const send = jest
		.fn<ResendOwnerInvitationEmailService['send']>()
		.mockResolvedValue({ kind: 'accepted', messageId: '77777777-7777-4777-8777-777777777777' });
	const module = await Test.createTestingModule({
		imports: [PlatformServiceAuthModule],
		providers: [
			OwnerInvitationDeliveryGate,
			OwnerInvitationDeliveryService,
			OwnerInvitationDeliveryWorkerService,
			OwnerInvitationTokenService,
			OwnerInvitationTokenEnvelopeService,
			{ provide: PrismaService, useValue: database.prisma },
			{ provide: ConfigService, useValue: config },
			{ provide: PlatformOwnerInvitationAudit, useClass: DurableOwnerInvitationAudit },
			{ provide: ResendOwnerInvitationEmailService, useValue: { send } },
		],
	}).compile();
	const principal = await module
		.get(PlatformSessionService)
		.authenticate('fictional-service-session-with-at-least-32-characters');
	return {
		principal,
		...database,
		config,
		send,
		module,
		service: module.get(OwnerInvitationDeliveryService),
		worker: module.get(OwnerInvitationDeliveryWorkerService),
	};
}

describe('audited invitation delivery and worker policy', () => {
	it('denies direct delivery reservations without a server-issued platform identity', async () => {
		const fixture = await setup();
		try {
			for (const identity of [undefined, { ...fixture.principal }]) {
				await expect(
					fixture.service.queue(context, identity, ORGANIZATION_ID, OWNER_INVITATION_ID),
				).rejects.toMatchObject({ status: 403 });
			}
			expect(fixture.deliveryCreate).not.toHaveBeenCalled();
			expect(fixture.state.delivery).toBeNull();
		} finally {
			await fixture.module.close();
		}
	});

	it('creates one encrypted reservation and one audit; duplicates mint no new token', async () => {
		const fixture = await setup();
		try {
			const first = await fixture.service.queue(
				context,
				fixture.principal,
				ORGANIZATION_ID,
				OWNER_INVITATION_ID,
			);
			const digest = fixture.state.delivery?.tokenDigest;
			expect(
				await fixture.service.queue(
					context,
					fixture.principal,
					ORGANIZATION_ID,
					OWNER_INVITATION_ID,
				),
			).toEqual(first);
			expect(fixture.deliveryCreate).toHaveBeenCalledTimes(1);
			expect(fixture.ownershipAuditCreate).toHaveBeenCalledTimes(1);
			const auditCall: unknown = fixture.ownershipAuditCreate.mock.calls[0]?.[0];
			expect(auditCall).toMatchObject({
				data: {
					action: 'INVITATION_DELIVERY_QUEUED',
					previousInvitationStatus: 'PENDING_DELIVERY',
					resultingInvitationStatus: 'PENDING_DELIVERY',
				},
			});
			expect(fixture.state.delivery?.tokenDigest).toBe(digest);
			expect(Object.keys(first).sort()).toEqual(['message', 'status']);
			expect(fixture.send).not.toHaveBeenCalled();
		} finally {
			await fixture.module.close();
		}
	});

	it('rolls back on audit failure and fails closed before writes for a missing repair or disabled gate', async () => {
		const fixture = await setup();
		const disabled = await setup({
			...invitationDeliveryInput(),
			OWNER_INVITATION_DELIVERY_ENABLED: 'false',
		});
		try {
			fixture.ownershipAuditCreate.mockRejectedValueOnce(new Error('private database error'));
			await expect(
				fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
			).rejects.toBeInstanceOf(ServiceUnavailableException);
			expect(fixture.state.delivery).toBeNull();
			fixture.state.ready = false;
			await expect(
				fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
			).rejects.toBeInstanceOf(ServiceUnavailableException);
			await expect(
				disabled.service.queue(context, disabled.principal, ORGANIZATION_ID, OWNER_INVITATION_ID),
			).rejects.toBeInstanceOf(ServiceUnavailableException);
			expect(fixture.deliveryCreate).toHaveBeenCalledTimes(1);
			expect(disabled.deliveryCreate).not.toHaveBeenCalled();
		} finally {
			await fixture.module.close();
			await disabled.module.close();
		}
	});

	it('atomically confirms provider acceptance and erases the envelope without activating identities', async () => {
		const fixture = await setup();
		try {
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			const digest = fixture.state.delivery?.tokenDigest;
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.send).toHaveBeenCalledTimes(1);
			expect(fixture.state.delivery).toMatchObject({
				status: 'CONFIRMED',
				attemptCount: 1,
				tokenDigest: null,
				tokenCiphertext: null,
				claimedBy: null,
			});
			expect(fixture.state.invitation).toMatchObject({ status: 'SENT', tokenDigest: digest });
			expect(fixture.state.invitation.sentAt).toEqual(fixture.state.delivery?.confirmedAt);
			expect(fixture.userCreate).not.toHaveBeenCalled();
			expect(fixture.membershipCreate).not.toHaveBeenCalled();
			expect(fixture.membershipRoleCreate).not.toHaveBeenCalled();
		} finally {
			await fixture.module.close();
		}
	});

	it.each<InvitationProviderOutcome>([
		{ kind: 'uncertain', code: 'PROVIDER_OUTCOME_UNKNOWN' },
		{ kind: 'failed', code: 'PROVIDER_REJECTED', retryable: false },
		{ kind: 'failed', code: 'PROVIDER_RATE_LIMITED', retryable: true },
	])('records provider classification without marking the invitation sent: %j', async (outcome) => {
		const fixture = await setup();
		try {
			fixture.send.mockResolvedValue(outcome);
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.state.invitation.status).toBe(InvitationStatus.PENDING_DELIVERY);
			expect(fixture.state.delivery?.status).toBe(
				outcome.kind === 'uncertain' ? DeliveryStatus.UNCERTAIN : DeliveryStatus.FAILED,
			);
			if (outcome.kind === 'failed' && outcome.retryable) {
				expect(fixture.state.delivery?.nextAttemptAt).not.toBeNull();
				expect(fixture.state.delivery?.tokenCiphertext).not.toBeNull();
			} else if (outcome.kind === 'failed')
				expect(fixture.state.delivery?.tokenCiphertext).toBeNull();
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.send).toHaveBeenCalledTimes(1);
		} finally {
			await fixture.module.close();
		}
	});

	it('recovers an abandoned lease as uncertain and later erases it without resending', async () => {
		const fixture = await setup();
		try {
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			const row = fixture.state.delivery;
			if (row === null) throw new Error('Missing reservation.');
			Object.assign(row, {
				status: DeliveryStatus.PROCESSING,
				attemptCount: 1,
				nextAttemptAt: null,
				claimedBy: 'dead-worker',
				leaseAcquiredAt: new Date(fixture.state.now.getTime() - 60_000),
				leaseExpiresAt: new Date(fixture.state.now.getTime() - 1),
			});
			await fixture.worker.runOnce('recovery-worker');
			expect(fixture.state.delivery?.status).toBe(DeliveryStatus.UNCERTAIN);
			fixture.state.now = new Date(row.tokenExpiresAt.getTime() + 1);
			await fixture.worker.runOnce('recovery-worker');
			expect(fixture.state.delivery?.tokenCiphertext).toBeNull();
			expect(fixture.state.delivery?.status).toBe(DeliveryStatus.UNCERTAIN);
			expect(fixture.send).not.toHaveBeenCalled();
		} finally {
			await fixture.module.close();
		}
	});

	it('does not take over another worker’s live lease or submit another email', async () => {
		const fixture = await setup();
		try {
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			const row = fixture.state.delivery;
			if (row === null) throw new Error('Missing reservation.');
			Object.assign(row, {
				status: DeliveryStatus.PROCESSING,
				attemptCount: 1,
				nextAttemptAt: null,
				claimedBy: 'other-worker',
				leaseAcquiredAt: fixture.state.now,
				leaseExpiresAt: new Date(fixture.state.now.getTime() + 60_000),
			});
			await fixture.worker.runOnce('different-worker');
			expect(fixture.state.delivery).toMatchObject({
				status: DeliveryStatus.PROCESSING,
				claimedBy: 'other-worker',
				attemptCount: 1,
			});
			expect(fixture.send).not.toHaveBeenCalled();
		} finally {
			await fixture.module.close();
		}
	});

	it('records uncertainty after a finalization rollback rather than resubmitting an accepted email', async () => {
		const fixture = await setup();
		try {
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			fixture.invitationUpdate.mockResolvedValueOnce({ count: 0 });
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.state.delivery).toMatchObject({
				status: DeliveryStatus.UNCERTAIN,
				lastErrorCode: 'DATABASE_FINALIZATION_UNCERTAIN',
			});
			expect(fixture.state.invitation.status).toBe(InvitationStatus.PENDING_DELIVERY);
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.send).toHaveBeenCalledTimes(1);
		} finally {
			await fixture.module.close();
		}
	});

	it('keeps the exact payload/key on a bounded known-rejection retry despite a organization rename', async () => {
		const fixture = await setup();
		try {
			fixture.send.mockResolvedValueOnce({
				kind: 'failed',
				code: 'PROVIDER_RATE_LIMITED',
				retryable: true,
			});
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			await fixture.worker.runOnce('fictional-worker');
			const retryAt = fixture.state.delivery?.nextAttemptAt;
			if (retryAt === null || retryAt === undefined) throw new Error('Missing retry.');
			fixture.state.invitation.organization.name = 'Renamed organization';
			fixture.state.now = new Date(retryAt.getTime() + 1);
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.send.mock.calls[1]).toEqual(fixture.send.mock.calls[0]);
			expect(fixture.state.delivery).toMatchObject({
				status: DeliveryStatus.CONFIRMED,
				attemptCount: 2,
			});
		} finally {
			await fixture.module.close();
		}
	});

	it('does not confirm provider acceptance after the worker lease has expired', async () => {
		const fixture = await setup();
		try {
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			fixture.send.mockImplementation(() => {
				fixture.state.now = new Date(fixture.state.now.getTime() + 120_000);
				return Promise.resolve({
					kind: 'accepted',
					messageId: '77777777-7777-4777-8777-777777777777',
				});
			});
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.state.delivery?.status).toBe(DeliveryStatus.UNCERTAIN);
			expect(fixture.state.invitation.status).toBe(InvitationStatus.PENDING_DELIVERY);
		} finally {
			await fixture.module.close();
		}
	});

	it('closes a known rejection at the attempt limit without retaining a retryable token', async () => {
		const fixture = await setup({
			...invitationDeliveryInput(),
			OWNER_INVITATION_DELIVERY_MAX_ATTEMPTS: '1',
		});
		try {
			fixture.send.mockResolvedValue({
				kind: 'failed',
				code: 'PROVIDER_RATE_LIMITED',
				retryable: true,
			});
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.state.delivery).toMatchObject({
				status: DeliveryStatus.FAILED,
				attemptCount: 1,
				nextAttemptAt: null,
				tokenCiphertext: null,
				tokenDigest: null,
			});
		} finally {
			await fixture.module.close();
		}
	});

	it.each([
		'revoked-before',
		'suspended-actor',
		'permission-revoked',
		'expired-token',
		'revoked-after-provider',
	])('does not resurrect an invitation: %s', async (condition) => {
		const fixture = await setup();
		try {
			await fixture.service.queue(context, fixture.principal, ORGANIZATION_ID, OWNER_INVITATION_ID);
			if (condition === 'revoked-before')
				fixture.state.invitation.status = InvitationStatus.REVOKED;
			if (condition === 'suspended-actor')
				fixture.state.actor.status = PlatformStaffStatus.SUSPENDED;
			if (condition === 'permission-revoked') fixture.state.actor.roles = [];
			if (condition === 'expired-token') fixture.state.now = new Date('2026-11-01T00:00:00Z');
			if (condition === 'revoked-after-provider')
				fixture.send.mockImplementation(() => {
					fixture.state.invitation.status = InvitationStatus.REVOKED;
					return Promise.resolve({
						kind: 'accepted',
						messageId: '77777777-7777-4777-8777-777777777777',
					});
				});
			await fixture.worker.runOnce('fictional-worker');
			expect(fixture.state.invitation.status).not.toBe(InvitationStatus.SENT);
			expect(fixture.state.delivery?.status).toBe(
				condition === 'revoked-after-provider' ? DeliveryStatus.UNCERTAIN : DeliveryStatus.FAILED,
			);
			expect(fixture.send).toHaveBeenCalledTimes(condition === 'revoked-after-provider' ? 1 : 0);
		} finally {
			await fixture.module.close();
		}
	});

	it('rejects unknown statuses and uses the same invalid preview response without side effects', async () => {
		expect(() => deliveryResponse('UNRECOGNIZED')).toThrow();
		const fixture = await setup();
		try {
			fixture.state.previewValid = false;
			const tokens = fixture.module.get(OwnerInvitationTokenService);
			for (const token of ['', tokens.generate(), tokens.generate()]) {
				await expect(fixture.service.preview(token)).rejects.toMatchObject({
					status: 401,
					response: { code: 'OWNER_INVITATION_INVALID' },
				});
			}
			fixture.state.previewValid = true;
			const valid = tokens.generate();
			Object.assign(fixture.state.invitation, {
				status: InvitationStatus.SENT,
				tokenDigest: tokens.digest(valid),
				expiresAt: new Date(fixture.state.now.getTime() + 60_000),
			});
			await expect(fixture.service.preview(valid)).resolves.toEqual({
				valid: true,
				organizationName: 'Kimihurura Supplies',
			});
			expect(
				fixture.query.mock.calls.some(([parts]) =>
					parts.join('').includes("invitation.status = 'sent'"),
				),
			).toBe(true);
			expect(fixture.invitationUpdate).not.toHaveBeenCalled();
			expect(fixture.userCreate).not.toHaveBeenCalled();
		} finally {
			await fixture.module.close();
		}
	});
});
