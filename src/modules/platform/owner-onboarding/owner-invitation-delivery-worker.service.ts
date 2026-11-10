import { randomInt } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
	OrganizationOwnerInvitationDeliveryStatus as DeliveryStatus,
	OrganizationOwnerInvitationStatus as InvitationStatus,
	OrganizationStatus,
	PlatformStaffStatus,
	PrismaService,
	UserStatus,
	type OrganizationOwnerInvitationDelivery,
	type Prisma,
} from '@nexcoderw/akiba-db';

import {
	ResendOwnerInvitationEmailService,
	type InvitationProviderOutcome,
} from '../../../infrastructure/email/resend-owner-invitation-email.service.js';
import { effectivePlatformPermissions } from '../auth/platform-permission-policy.js';
import {
	INVITATION_DELIVERY_TRANSACTION,
	lockInvitationParents,
	OwnerInvitationDeliveryGate,
} from './owner-invitation-delivery.policy.js';
import {
	OwnerInvitationTokenEnvelopeService,
	type InvitationEmailSnapshot,
} from './owner-invitation-token-envelope.service.js';
import { OwnerInvitationTokenService } from './owner-invitation-token.service.js';
import { OWNER_INVITATION_PERMISSION } from './platform-owner-onboarding.constants.js';

type Delivery = OrganizationOwnerInvitationDelivery;
type Candidate = Pick<Delivery, 'id' | 'organizationId' | 'ownerInvitationId'>;

@Injectable()
export class OwnerInvitationDeliveryWorkerService {
	private readonly logger = new Logger(OwnerInvitationDeliveryWorkerService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly gate: OwnerInvitationDeliveryGate,
		private readonly envelopes: OwnerInvitationTokenEnvelopeService,
		private readonly tokens: OwnerInvitationTokenService,
		private readonly email: ResendOwnerInvitationEmailService,
	) {}

	/** Explicit CLI only: no startup hook, timer, provider call or mutation during module construction. */
	async runOnce(workerId: string): Promise<number> {
		if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(workerId))
			throw new Error('A stable worker identity is required.');
		const settings = this.gate.settings();
		await this.gate.assertDatabase();
		const candidates = await this.prisma.$queryRaw<Candidate[]>`
			SELECT id, organization_id AS "organizationId", owner_invitation_id AS "ownerInvitationId"
			FROM public.organization_owner_invitation_deliveries
			WHERE (status IN ('queued', 'failed') AND next_attempt_at <= clock_timestamp())
			OR (status = 'processing' AND lease_expires_at <= clock_timestamp())
			OR (status = 'uncertain' AND token_erased_at IS NULL AND token_expires_at <= clock_timestamp())
			ORDER BY created_at, id LIMIT ${settings.concurrency}
		`;
		const outcomes = await Promise.allSettled(
			candidates.map((candidate) => this.process(candidate, workerId)),
		);
		for (const outcome of outcomes) {
			if (outcome.status === 'rejected') {
				// Do not log rejected values: provider/envelope errors may contain sensitive payloads.
				this.logger.error({ code: 'OWNER_INVITATION_WORKER_OPERATION_FAILED', workerId });
			}
		}
		if (outcomes.some((outcome) => outcome.status === 'rejected')) {
			throw new Error('Worker stopped after an unresolved persistence operation.');
		}
		return candidates.length;
	}

	private async process(candidate: Candidate, workerId: string): Promise<void> {
		const claimed = await this.claim(candidate, workerId);
		if (claimed === null) return;
		let snapshot: InvitationEmailSnapshot;
		try {
			const envelope = envelopeOf(claimed);
			snapshot = this.envelopes.decrypt(claimed, envelope);
			if (
				claimed.tokenDigest === null ||
				!this.tokens.matches(snapshot.token, claimed.tokenDigest)
			) {
				throw new Error('Invalid invitation envelope.');
			}
		} catch {
			await this.finalize(claimed, workerId, {
				kind: 'failed',
				code: 'DELIVERY_CONFIGURATION_CHANGED',
				retryable: false,
			});
			return;
		}
		if (!(await this.beforeSubmission(claimed, workerId, snapshot.recipient))) return;
		let outcome: InvitationProviderOutcome;
		try {
			// External transport is deliberately outside every database transaction and row lock.
			outcome = await this.email.send(
				snapshot,
				claimed.providerIdempotencyKey,
				claimed.tokenExpiresAt,
			);
		} catch {
			outcome = { kind: 'uncertain', code: 'PROVIDER_OUTCOME_UNKNOWN' };
		}
		try {
			await this.finalize(claimed, workerId, outcome);
		} catch {
			// A failed COMMIT can be ambiguous. Never retry submission or assume rollback/success.
			await this.recordUncertain(
				claimed,
				workerId,
				'DATABASE_FINALIZATION_UNCERTAIN',
				outcome.kind === 'accepted' ? outcome.messageId : undefined,
			);
		}
	}

	private async claim(candidate: Candidate, workerId: string): Promise<Delivery | null> {
		return this.prisma.$transaction(async (transaction) => {
			const now = await lockInvitationParents(
				transaction,
				candidate.organizationId,
				candidate.ownerInvitationId,
				candidate.id,
			);
			const row = await transaction.organizationOwnerInvitationDelivery.findFirst({
				where: candidate,
			});
			if (row === null) return null;
			if (row.status === DeliveryStatus.PROCESSING) {
				if (row.leaseExpiresAt !== null && row.leaseExpiresAt <= now) {
					await this.uncertain(transaction, row, now, 'WORKER_LEASE_EXPIRED');
				}
				return null;
			}
			if (row.status === DeliveryStatus.UNCERTAIN) {
				if (row.tokenErasedAt === null && row.tokenExpiresAt <= now) {
					await this.update(transaction, row, { ...erase(now), updatedAt: now });
				}
				return null;
			}
			if (
				(row.status !== DeliveryStatus.QUEUED && row.status !== DeliveryStatus.FAILED) ||
				row.nextAttemptAt === null ||
				row.nextAttemptAt > now
			)
				return null;
			if (row.attemptCount >= row.maxAttempts || !(await this.eligible(transaction, row, now))) {
				await this.knownFailure(transaction, row, now, 'DELIVERY_INELIGIBLE');
				return null;
			}
			const result = await transaction.organizationOwnerInvitationDelivery.updateMany({
				where: condition(row),
				data: {
					status: DeliveryStatus.PROCESSING,
					attemptCount: { increment: 1 },
					nextAttemptAt: null,
					leaseAcquiredAt: now,
					leaseExpiresAt: new Date(
						Math.min(
							row.tokenExpiresAt.getTime(),
							now.getTime() + this.gate.settings().leaseSeconds * 1000,
						),
					),
					claimedBy: workerId,
					failedAt: null,
					lastErrorCode: null,
					updatedAt: now,
				},
			});
			if (result.count !== 1) return null;
			return transaction.organizationOwnerInvitationDelivery.findFirst({
				where: { id: row.id, organizationId: row.organizationId },
			});
		}, INVITATION_DELIVERY_TRANSACTION);
	}

	private async beforeSubmission(
		row: Delivery,
		workerId: string,
		recipient: string,
	): Promise<boolean> {
		return this.prisma.$transaction(async (transaction) => {
			const now = await lockInvitationParents(
				transaction,
				row.organizationId,
				row.ownerInvitationId,
				row.id,
			);
			const current = await transaction.organizationOwnerInvitationDelivery.findFirst({
				where: owned(row, workerId),
			});
			if (current === null) return false;
			if (
				!liveLease(current, now) ||
				(current.leaseExpiresAt !== null &&
					current.leaseExpiresAt.getTime() - now.getTime() < 20_000)
			) {
				await this.uncertain(transaction, current, now, 'WORKER_LEASE_EXPIRED');
				return false;
			}
			const invitation = await transaction.organizationOwnerInvitation.findFirst({
				where: { organizationId: row.organizationId, id: row.ownerInvitationId },
				select: { invitedEmail: true },
			});
			if (
				invitation?.invitedEmail !== recipient ||
				!(await this.eligible(transaction, current, now))
			) {
				await this.knownFailure(transaction, current, now, 'DELIVERY_INELIGIBLE');
				return false;
			}
			const clock = await transaction.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
			const checkedAt = clock[0]?.now;
			if (!(checkedAt instanceof Date)) throw new Error('Delivery clock unavailable.');
			if (
				current.leaseExpiresAt === null ||
				current.leaseExpiresAt.getTime() - checkedAt.getTime() < 20_000
			) {
				await this.uncertain(transaction, current, checkedAt, 'WORKER_LEASE_EXPIRED');
				return false;
			}
			return true;
		}, INVITATION_DELIVERY_TRANSACTION);
	}

	private async finalize(
		row: Delivery,
		workerId: string,
		outcome: InvitationProviderOutcome,
	): Promise<void> {
		await this.prisma.$transaction(async (transaction) => {
			const now = await lockInvitationParents(
				transaction,
				row.organizationId,
				row.ownerInvitationId,
				row.id,
			);
			const current = await transaction.organizationOwnerInvitationDelivery.findFirst({
				where: owned(row, workerId),
			});
			if (current === null) return;
			if (!liveLease(current, now)) {
				await this.uncertain(
					transaction,
					current,
					now,
					'WORKER_LEASE_EXPIRED',
					outcome.kind === 'accepted' ? outcome.messageId : undefined,
				);
				return;
			}
			const eligible = await this.eligible(transaction, current, now);
			if (outcome.kind === 'uncertain' || (outcome.kind === 'accepted' && !eligible)) {
				await this.uncertain(
					transaction,
					current,
					now,
					outcome.kind === 'uncertain' ? outcome.code : 'DELIVERY_BECAME_INELIGIBLE',
					outcome.kind === 'accepted' ? outcome.messageId : undefined,
				);
				return;
			}
			if (outcome.kind === 'failed') {
				const retryAt = new Date(
					now.getTime() +
						Math.min(300_000, 30_000 * 2 ** (current.attemptCount - 1)) +
						randomInt(1000, 5001),
				);
				// Provider idempotency retention is 24h. Stop safely short of that, even for a 7-day token.
				if (
					eligible &&
					outcome.retryable &&
					current.attemptCount < current.maxAttempts &&
					retryAt < current.tokenExpiresAt &&
					retryAt.getTime() < current.createdAt.getTime() + 23 * 3_600_000
				) {
					await this.update(transaction, current, {
						status: DeliveryStatus.FAILED,
						failedAt: now,
						nextAttemptAt: retryAt,
						lastErrorCode: outcome.code,
						...releaseLease(),
						updatedAt: now,
					});
				} else {
					await this.knownFailure(transaction, current, now, outcome.code);
				}
				return;
			}
			if (current.tokenDigest === null) throw new Error('Delivery finalization unavailable.');
			const invitation = await transaction.organizationOwnerInvitation.updateMany({
				where: {
					id: current.ownerInvitationId,
					organizationId: current.organizationId,
					status: InvitationStatus.PENDING_DELIVERY,
				},
				data: {
					status: InvitationStatus.SENT,
					tokenDigest: current.tokenDigest,
					expiresAt: current.tokenExpiresAt,
					sentAt: now,
					updatedAt: now,
				},
			});
			if (invitation.count !== 1) throw new Error('Delivery finalization changed.');
			await this.update(transaction, current, {
				status: DeliveryStatus.CONFIRMED,
				confirmedAt: now,
				providerMessageId: outcome.messageId,
				nextAttemptAt: null,
				lastErrorCode: null,
				...releaseLease(),
				...erase(now),
				updatedAt: now,
			});
		}, INVITATION_DELIVERY_TRANSACTION);
	}

	private async recordUncertain(
		row: Delivery,
		workerId: string,
		code: string,
		messageId?: string,
	): Promise<void> {
		await this.prisma.$transaction(async (transaction) => {
			const now = await lockInvitationParents(
				transaction,
				row.organizationId,
				row.ownerInvitationId,
				row.id,
			);
			const current = await transaction.organizationOwnerInvitationDelivery.findFirst({
				where: owned(row, workerId),
			});
			if (current !== null) await this.uncertain(transaction, current, now, code, messageId);
		}, INVITATION_DELIVERY_TRANSACTION);
	}

	private async eligible(
		transaction: Prisma.TransactionClient,
		row: Delivery,
		now: Date,
	): Promise<boolean> {
		if (row.tokenExpiresAt <= now || row.tokenDigest === null) return false;
		const invitation = await transaction.organizationOwnerInvitation.findFirst({
			where: { id: row.ownerInvitationId, organizationId: row.organizationId },
			select: { status: true, organization: { select: { status: true } } },
		});
		const organizationStatus = invitation?.organization.status;
		if (
			invitation?.status !== InvitationStatus.PENDING_DELIVERY ||
			(organizationStatus !== OrganizationStatus.PENDING &&
				organizationStatus !== OrganizationStatus.ACTIVE)
		)
			return false;
		const actor = await transaction.platformStaff.findUnique({
			where: { id: row.requestedByPlatformStaffId },
			select: {
				status: true,
				user: { select: { status: true, emailVerifiedAt: true } },
				roles: {
					select: {
						platformRole: {
							select: {
								key: true,
								isSystem: true,
								permissions: { select: { platformPermission: { select: { key: true } } } },
							},
						},
					},
				},
			},
		});
		return (
			actor !== null &&
			actor.status === PlatformStaffStatus.ACTIVE &&
			actor.user.status === UserStatus.ACTIVE &&
			actor.user.emailVerifiedAt !== null &&
			effectivePlatformPermissions(actor.roles).includes(OWNER_INVITATION_PERMISSION.send)
		);
	}

	private async knownFailure(
		transaction: Prisma.TransactionClient,
		row: Delivery,
		now: Date,
		code: string,
	): Promise<void> {
		await this.update(transaction, row, {
			status: DeliveryStatus.FAILED,
			failedAt: now,
			nextAttemptAt: null,
			lastErrorCode: code,
			...releaseLease(),
			...erase(now),
			updatedAt: now,
		});
	}

	private async uncertain(
		transaction: Prisma.TransactionClient,
		row: Delivery,
		now: Date,
		code: string,
		messageId?: string,
	): Promise<void> {
		await this.update(transaction, row, {
			status: DeliveryStatus.UNCERTAIN,
			uncertainAt: now,
			nextAttemptAt: null,
			failedAt: null,
			lastErrorCode: code,
			...releaseLease(),
			updatedAt: now,
			...(messageId === undefined ? {} : { providerMessageId: messageId }),
		});
		this.logger.warn({
			code: 'OWNER_INVITATION_DELIVERY_UNCERTAIN',
			deliveryId: row.id,
			organizationId: row.organizationId,
		});
	}

	private async update(
		transaction: Prisma.TransactionClient,
		row: Delivery,
		data: Prisma.OrganizationOwnerInvitationDeliveryUpdateManyMutationInput,
	): Promise<void> {
		const result = await transaction.organizationOwnerInvitationDelivery.updateMany({
			where: condition(row),
			data,
		});
		if (result.count !== 1) throw new Error('Delivery reservation changed.');
	}
}

function condition(row: Delivery) {
	return {
		id: row.id,
		organizationId: row.organizationId,
		ownerInvitationId: row.ownerInvitationId,
		status: row.status,
		attemptCount: row.attemptCount,
		claimedBy: row.claimedBy,
		leaseAcquiredAt: row.leaseAcquiredAt,
		leaseExpiresAt: row.leaseExpiresAt,
	};
}

function owned(row: Delivery, workerId: string) {
	return { ...condition(row), status: DeliveryStatus.PROCESSING, claimedBy: workerId };
}

function liveLease(row: Delivery, now: Date): boolean {
	return row.leaseExpiresAt !== null && row.leaseExpiresAt > now;
}

function releaseLease() {
	return { leaseAcquiredAt: null, leaseExpiresAt: null, claimedBy: null };
}

function erase(now: Date) {
	return {
		tokenDigest: null,
		tokenCiphertext: null,
		tokenInitializationVector: null,
		tokenAuthenticationTag: null,
		tokenEncryptionKeyId: null,
		tokenEncryptionVersion: null,
		tokenErasedAt: now,
	};
}

function envelopeOf(row: Delivery) {
	if (
		row.tokenCiphertext === null ||
		row.tokenInitializationVector === null ||
		row.tokenAuthenticationTag === null ||
		row.tokenEncryptionKeyId === null ||
		row.tokenEncryptionVersion === null
	)
		throw new Error('Missing envelope.');
	return {
		tokenCiphertext: row.tokenCiphertext,
		tokenInitializationVector: row.tokenInitializationVector,
		tokenAuthenticationTag: row.tokenAuthenticationTag,
		tokenEncryptionKeyId: row.tokenEncryptionKeyId,
		tokenEncryptionVersion: row.tokenEncryptionVersion,
	};
}
