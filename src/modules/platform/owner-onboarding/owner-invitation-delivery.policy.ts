import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, type Prisma } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import type { OwnerInvitationDeliveryEnvironment } from '../../../config/owner-invitation-delivery.environment.js';

export const INVITATION_DELIVERY_TRANSACTION = Object.freeze({ maxWait: 5_000, timeout: 10_000 });

export function invitationDeliveryUnavailable(cause?: unknown): ServiceUnavailableException {
	return new ServiceUnavailableException(
		{
			code: 'OWNER_INVITATION_DELIVERY_UNAVAILABLE',
			message: 'Invitation delivery is unavailable. No delivery success has been confirmed.',
		},
		{ cause },
	);
}

export function invitationDeliveryFailure(error: unknown): HttpException {
	return error instanceof HttpException ? error : invitationDeliveryUnavailable(error);
}

@Injectable()
export class OwnerInvitationDeliveryGate {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
	) {}

	settings(): OwnerInvitationDeliveryEnvironment {
		const value = this.config.get('OWNER_INVITATION_DELIVERY', { infer: true });
		if (value === null) throw invitationDeliveryUnavailable();
		return value;
	}

	sender(): string {
		this.settings();
		const sender = this.config.get('RESEND_FROM_EMAIL', { infer: true });
		if (sender === null) throw invitationDeliveryUnavailable();
		return sender;
	}

	/** No cache: a missing repair, disabled guard or restored PUBLIC grant fails closed. */
	async assertDatabase(): Promise<void> {
		this.settings();
		try {
			const rows = await this.prisma.$queryRaw<{ ready: boolean }[]>`
				SELECT (
					(SELECT count(*) = 6 FROM pg_catalog.pg_constraint
					 WHERE conrelid = to_regclass('public.organization_owner_invitation_deliveries')
					 AND contype = 'c' AND convalidated AND conname IN (
						'organization_owner_invitation_deliveries_lifecycle_check',
						'organization_owner_invitation_deliveries_lease_check',
						'organization_owner_invitation_deliveries_retry_check',
						'organization_owner_invitation_deliveries_token_material_check',
						'organization_owner_invitation_deliveries_timestamp_order_check',
						'organization_owner_invitation_deliveries_bounded_text_check'))
					AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
					 WHERE tgrelid = to_regclass('public.organization_owner_invitation_deliveries')
					 AND tgname = 'owner_invitation_delivery_guard' AND tgenabled IN ('O', 'A'))
					AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
					 WHERE tgrelid = to_regclass('public.organization_owner_invitations')
					 AND tgname = 'organization_owner_invitation_identity_guard' AND tgenabled IN ('O', 'A'))
					AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
					 WHERE conrelid = to_regclass('public.organization_ownership_audit_events')
					 AND convalidated AND contype = 'c'
					 AND pg_get_constraintdef(oid) LIKE '%invitation_delivery_queued%')
					AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation,
					 LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) AS acl
					 WHERE relation.oid IN (
						to_regclass('public.organization_owner_invitation_deliveries'),
						to_regclass('public.organization_owner_invitations'),
						to_regclass('public.organization_ownership_audit_events')) AND acl.grantee = 0)
					AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS column_privilege,
					 LATERAL aclexplode(column_privilege.attacl) AS acl
					 WHERE column_privilege.attrelid IN (
						to_regclass('public.organization_owner_invitation_deliveries'),
						to_regclass('public.organization_owner_invitations'),
						to_regclass('public.organization_ownership_audit_events')) AND acl.grantee = 0)
					AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type AS delivery_type,
					 LATERAL aclexplode(COALESCE(delivery_type.typacl, acldefault('T', delivery_type.typowner))) AS acl
					 WHERE delivery_type.oid = to_regtype('public.organization_owner_invitation_delivery_status') AND acl.grantee = 0)
					AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS routine,
					 LATERAL aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) AS acl
					 WHERE routine.oid IN (to_regprocedure('public.guard_owner_invitation_delivery()'),
						to_regprocedure('public.guard_organization_owner_invitation_identity()')) AND acl.grantee = 0)
					AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
					 WHERE conrelid = to_regclass('public.organization_owner_invitation_deliveries')
					 AND conname = 'organization_owner_invitation_deliveries_token_material_check'
					 AND pg_get_constraintdef(oid) LIKE '%4096%')
				) AS ready
			`;
			if (rows[0]?.ready !== true) throw invitationDeliveryUnavailable();
		} catch (error: unknown) {
			throw invitationDeliveryFailure(error);
		}
	}
}

/** Shared lock order with the reviewed trigger: organization, invitation, then delivery. */
export async function lockInvitationParents(
	transaction: Prisma.TransactionClient,
	organizationId: string,
	invitationId: string,
	deliveryId?: string,
): Promise<Date> {
	await transaction.$queryRaw`SELECT id FROM public.organizations WHERE id = ${organizationId}::uuid FOR SHARE`;
	await transaction.$queryRaw`SELECT id FROM public.organization_owner_invitations
		WHERE organization_id = ${organizationId}::uuid AND id = ${invitationId}::uuid FOR UPDATE`;
	if (deliveryId !== undefined) {
		await transaction.$queryRaw`SELECT id FROM public.organization_owner_invitation_deliveries
			WHERE organization_id = ${organizationId}::uuid AND id = ${deliveryId}::uuid FOR UPDATE`;
	}
	const rows = await transaction.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
	const now = rows[0]?.now;
	if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
		throw invitationDeliveryUnavailable();
	return now;
}
