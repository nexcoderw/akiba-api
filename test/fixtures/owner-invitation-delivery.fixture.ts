import { randomBytes } from 'node:crypto';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import {
	OrganizationOwnerInvitationDeliveryStatus,
	OrganizationOwnerInvitationStatus,
	OrganizationStatus,
	type OrganizationOwnerInvitationDelivery,
	type Prisma,
} from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { OWNER_INVITATION_PERMISSION } from '../../src/modules/platform/owner-onboarding/platform-owner-onboarding.constants.js';
import {
	createPlatformOwnerOnboardingDatabaseFixture,
	ownerInvitationFixture,
} from './platform-owner-onboarding-database.fixture.js';
import {
	organizationFixture,
	ORGANIZATION_ID,
	organizationSessionFixture,
} from './platform-organizations-database.fixture.js';

/** Fictional, per-test cryptographic material; never a deployable credential or real provider. */
export function invitationDeliveryInput(): Record<string, unknown> {
	return {
		NODE_ENV: 'test',
		CORS_ORIGINS: 'http://localhost:4000,https://owners.example.invalid',
		ORGANIZATION_PORTAL_ORIGIN: 'https://owners.example.invalid',
		OWNER_INVITATION_DELIVERY_ENABLED: 'true',
		OWNER_INVITATION_DELIVERY_DATABASE_APPROVED: 'true',
		OWNER_INVITATION_ACCEPTANCE_REVIEW_ID: 'fictional-test-review',
		OWNER_INVITATION_ACCEPTANCE_PATH: '/invitations/accept',
		OWNER_INVITATION_TOKEN_HMAC_SECRET: randomBytes(32).toString('base64'),
		OWNER_INVITATION_ENCRYPTION_KEYRING: `test-key=${randomBytes(32).toString('base64')}`,
		OWNER_INVITATION_ENCRYPTION_ACTIVE_KEY_ID: 'test-key',
		RESEND_API_KEY: 're_fictional_never_sent',
		RESEND_FROM_EMAIL: 'onboarding@resend.dev',
	};
}

export function invitationDeliveryConfig(
	input = invitationDeliveryInput(),
): ConfigService<EnvironmentVariables, true> {
	return new ConfigService<EnvironmentVariables, true>(validateEnvironment(input));
}

/** Stateful adapter fake with transaction rollback; PostgreSQL tests, not this fake, prove locking. */
export function createInvitationDeliveryDatabaseFixture() {
	const base = createPlatformOwnerOnboardingDatabaseFixture();
	const state: {
		now: Date;
		delivery: OrganizationOwnerInvitationDelivery | null;
		invitation: ReturnType<typeof ownerInvitationFixture> & {
			organization: ReturnType<typeof organizationFixture>;
		};
		actor: ReturnType<typeof organizationSessionFixture>['platformStaff'];
		previewValid: boolean;
		ready: boolean;
	} = {
		now: new Date('2026-10-16T12:00:00.000Z'),
		delivery: null,
		invitation: { ...ownerInvitationFixture(), organization: organizationFixture() },
		actor: organizationSessionFixture([OWNER_INVITATION_PERMISSION.send]).platformStaff,
		previewValid: true,
		ready: true,
	};
	const deliveryFind = jest
		.fn<(args: unknown) => Promise<OrganizationOwnerInvitationDelivery | null>>()
		.mockImplementation(() => Promise.resolve(state.delivery));
	const deliveryCreate = jest
		.fn<(args: Prisma.OrganizationOwnerInvitationDeliveryCreateArgs) => Promise<{ id: string }>>()
		.mockImplementation((args) => {
			const data = args.data;
			if (
				typeof data.id !== 'string' ||
				typeof data.organizationId !== 'string' ||
				typeof data.ownerInvitationId !== 'string' ||
				typeof data.requestedByPlatformStaffId !== 'string' ||
				!(data.tokenExpiresAt instanceof Date)
			)
				throw new Error('Invalid fixture input.');
			state.delivery = {
				id: data.id,
				organizationId: data.organizationId,
				ownerInvitationId: data.ownerInvitationId,
				requestedByPlatformStaffId: data.requestedByPlatformStaffId,
				status: OrganizationOwnerInvitationDeliveryStatus.QUEUED,
				attemptCount: 0,
				maxAttempts: typeof data.maxAttempts === 'number' ? data.maxAttempts : 3,
				nextAttemptAt: state.now,
				createdAt: state.now,
				updatedAt: state.now,
				providerIdempotencyKey: data.providerIdempotencyKey,
				providerMessageId: null,
				lastErrorCode: null,
				leaseAcquiredAt: null,
				leaseExpiresAt: null,
				claimedBy: null,
				tokenDigest: typeof data.tokenDigest === 'string' ? data.tokenDigest : null,
				tokenCiphertext:
					data.tokenCiphertext instanceof Uint8Array ? new Uint8Array(data.tokenCiphertext) : null,
				tokenInitializationVector:
					data.tokenInitializationVector instanceof Uint8Array
						? new Uint8Array(data.tokenInitializationVector)
						: null,
				tokenAuthenticationTag:
					data.tokenAuthenticationTag instanceof Uint8Array
						? new Uint8Array(data.tokenAuthenticationTag)
						: null,
				tokenEncryptionKeyId:
					typeof data.tokenEncryptionKeyId === 'string' ? data.tokenEncryptionKeyId : null,
				tokenEncryptionVersion:
					typeof data.tokenEncryptionVersion === 'number' ? data.tokenEncryptionVersion : null,
				tokenExpiresAt: data.tokenExpiresAt,
				confirmedAt: null,
				failedAt: null,
				uncertainAt: null,
				tokenErasedAt: null,
			};
			return Promise.resolve({ id: data.id });
		});
	const deliveryUpdate = jest
		.fn<
			(args: Prisma.OrganizationOwnerInvitationDeliveryUpdateManyArgs) => Promise<{ count: number }>
		>()
		.mockImplementation(({ data }) => {
			if (state.delivery === null) return Promise.resolve({ count: 0 });
			const attemptCount =
				typeof data.attemptCount === 'object'
					? state.delivery.attemptCount + 1
					: state.delivery.attemptCount;
			Object.assign(state.delivery, data, { attemptCount });
			return Promise.resolve({ count: 1 });
		});
	const invitationFind = jest
		.fn<(args: unknown) => Promise<typeof state.invitation | null>>()
		.mockImplementation(() => Promise.resolve(state.invitation));
	const invitationUpdate = jest
		.fn<(args: Prisma.OrganizationOwnerInvitationUpdateManyArgs) => Promise<{ count: number }>>()
		.mockImplementation(({ data }) => {
			Object.assign(state.invitation, data);
			return Promise.resolve({ count: 1 });
		});
	const actorFind = jest
		.fn<(args: unknown) => Promise<typeof state.actor | null>>()
		.mockImplementation(() => Promise.resolve(state.actor));
	const query = jest
		.fn<(parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>()
		.mockImplementation((parts, ...values) => {
			const text = parts.join('?');
			if (text.includes('AS ready')) return Promise.resolve([{ ready: state.ready }]);
			if (text.includes('AS "organizationName"')) {
				const invitation = state.invitation;
				const valid =
					state.previewValid &&
					invitation.status === OrganizationOwnerInvitationStatus.SENT &&
					invitation.tokenDigest === values[0] &&
					invitation.expiresAt !== null &&
					invitation.expiresAt > state.now &&
					invitation.revokedAt === null &&
					invitation.acceptedAt === null &&
					(invitation.organization.status === OrganizationStatus.PENDING ||
						invitation.organization.status === OrganizationStatus.ACTIVE);
				return Promise.resolve(valid ? [{ organizationName: 'Kimihurura Supplies' }] : []);
			}
			if (text.includes('AS "ownerInvitationId"')) {
				return Promise.resolve(
					state.delivery === null
						? []
						: [
								{
									id: state.delivery.id,
									organizationId: ORGANIZATION_ID,
									ownerInvitationId: state.delivery.ownerInvitationId,
								},
							],
				);
			}
			return Promise.resolve([{ now: state.now }]);
		});
	const client = {
		...base.prisma,
		$queryRaw: query,
		organizationOwnerInvitationDelivery: {
			findFirst: deliveryFind,
			create: deliveryCreate,
			updateMany: deliveryUpdate,
		},
		organizationOwnerInvitation: {
			...base.prisma.organizationOwnerInvitation,
			findFirst: invitationFind,
			updateMany: invitationUpdate,
		},
		platformStaff: { findUnique: actorFind },
	};
	const transaction = jest
		.fn<
			(operation: (tx: typeof client) => Promise<unknown>, options?: unknown) => Promise<unknown>
		>()
		.mockImplementation(async (operation) => {
			const before = {
				delivery: structuredClone(state.delivery),
				invitation: structuredClone(state.invitation),
			};
			try {
				return await operation(client);
			} catch (error: unknown) {
				state.delivery = before.delivery;
				state.invitation = before.invitation;
				throw error;
			}
		});
	return {
		...base,
		state,
		query,
		deliveryFind,
		deliveryCreate,
		deliveryUpdate,
		invitationFind,
		invitationUpdate,
		actorFind,
		transaction,
		prisma: { ...client, $transaction: transaction },
	};
}
