import { ConflictException, Injectable } from '@nestjs/common';
import { OrganizationStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import type { CreateOrganizationDto } from './dto/create-organization.dto.js';
import type { UpdateOrganizationDto } from './dto/update-organization.dto.js';
import type { OrganizationResponseDto } from './dto/organization-response.dto.js';
import {
	PlatformOrganizationAudit,
	type OrganizationMutationContext,
} from './platform-organization-audit.js';
import {
	organizationFailure,
	organizationNotFound,
	staleOrganization,
} from './platform-organization-errors.js';
import {
	lifecycleStatus,
	ORGANIZATION_LIFECYCLE_TIMESTAMP,
	type OrganizationLifecycleAction,
} from './platform-organization-lifecycle.js';
import { ORGANIZATION_SELECT, organizationResponse } from './platform-organization-mapping.js';
import { ORGANIZATION_TRANSACTION_OPTIONS } from './platform-organizations.constants.js';

import { PlatformSessionService } from '../auth/platform-session.service.js';
import type { PlatformPrincipal } from '../auth/platform-auth.types.js';
import { PLATFORM_PERMISSION } from '../auth/platform-permission.constants.js';

@Injectable()
export class PlatformOrganizationMutationsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly sessions: PlatformSessionService,
		private readonly audit: PlatformOrganizationAudit,
	) {}

	async create(
		context: OrganizationMutationContext,
		principal: PlatformPrincipal | undefined,
		input: CreateOrganizationDto,
	): Promise<OrganizationResponseDto> {
		context = Object.freeze({ ...context });
		await this.sessions.authorize(principal, PLATFORM_PERMISSION.organizationsCreate, context.actorPlatformStaffId);
		this.audit.assertAvailable();
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const row = await transaction.organization.create({
					data: { name: input.name, slug: input.slug, status: OrganizationStatus.PENDING },
					select: ORGANIZATION_SELECT,
				});
				await this.audit.record(transaction, {
					...context,
					action: 'create',
					organizationId: row.id,
					occurredAt: new Date(),
					previousStatus: null,
					resultingStatus: row.status,
					changedFields: ['name', 'slug', 'status'],
					previousName: null,
					resultingName: row.name,
				});
				return organizationResponse(row);
			}, ORGANIZATION_TRANSACTION_OPTIONS);
		} catch (error: unknown) {
			throw organizationFailure(error);
		}
	}

	update(
		context: OrganizationMutationContext,
		principal: PlatformPrincipal | undefined,
		id: string,
		input: UpdateOrganizationDto,
		expected: Date,
	): Promise<OrganizationResponseDto> {
		return this.change(context, principal, id, expected, { name: input.name });
	}

	lifecycle(
		context: OrganizationMutationContext,
		principal: PlatformPrincipal | undefined,
		id: string,
		action: OrganizationLifecycleAction,
		expected: Date,
	): Promise<OrganizationResponseDto> {
		return this.change(context, principal, id, expected, { action });
	}

	private async change(
		context: OrganizationMutationContext,
		principal: PlatformPrincipal | undefined,
		id: string,
		expected: Date,
		command: { readonly name: string } | { readonly action: OrganizationLifecycleAction },
	): Promise<OrganizationResponseDto> {
		context = Object.freeze({ ...context });
		const permission = 'name' in command
			? PLATFORM_PERMISSION.organizationsUpdate
			: {
				activation: PLATFORM_PERMISSION.organizationsActivate,
				suspension: PLATFORM_PERMISSION.organizationsSuspend,
				archival: PLATFORM_PERMISSION.organizationsArchive,
			}[command.action];
		await this.sessions.authorize(principal, permission, context.actorPlatformStaffId);
		this.audit.assertAvailable();
		try {
			return await this.prisma.$transaction(
				async (transaction) => {
					const previous = await transaction.organization.findUnique({
						where: { id },
						select: ORGANIZATION_SELECT,
					});
					if (previous === null) throw organizationNotFound();
					if (previous.updatedAt.getTime() !== expected.getTime()) throw staleOrganization();
					if ('name' in command && previous.status === OrganizationStatus.ARCHIVED) {
						throw new ConflictException({
							code: 'ORGANIZATION_TRANSITION_CONFLICT',
							message: 'Archived organizations cannot be modified',
						});
					}
					const now = new Date();
					// API-managed writes advance monotonically even when two requests share a clock millisecond.
					const updatedAt = new Date(Math.max(now.getTime(), previous.updatedAt.getTime() + 1));
					const status =
						'action' in command
							? lifecycleStatus(previous.status, command.action)
							: previous.status;
					const data =
						'name' in command
							? { name: command.name, updatedAt }
							: {
									status,
									updatedAt,
									[ORGANIZATION_LIFECYCLE_TIMESTAMP[command.action]]: now,
								};
					const result = await transaction.organization.updateMany({
						where: { id, updatedAt: expected, status: previous.status },
						data,
					});
					if (result.count !== 1) throw staleOrganization();
					const row = await transaction.organization.findUnique({
						where: { id },
						select: ORGANIZATION_SELECT,
					});
					if (row === null) throw organizationNotFound();
					await this.audit.record(transaction, {
						...context,
						action: 'action' in command ? command.action : 'update',
						organizationId: id,
						occurredAt: now,
						previousStatus: previous.status,
						resultingStatus: row.status,
						changedFields:
							'name' in command
								? ['name']
								: ['status', ORGANIZATION_LIFECYCLE_TIMESTAMP[command.action]],
						previousName: 'name' in command ? previous.name : null,
						resultingName: 'name' in command ? row.name : null,
					});
					return organizationResponse(row);
				},
				{
					...ORGANIZATION_TRANSACTION_OPTIONS,
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				},
			);
		} catch (error: unknown) {
			throw organizationFailure(error);
		}
	}
}
