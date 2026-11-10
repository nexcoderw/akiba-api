import { BadRequestException, Injectable } from '@nestjs/common';
import { OrganizationStatus, Prisma, PrismaService } from '@nexcoderw/akiba-db';

import type { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto.js';
import type { OrganizationListResponseDto } from './dto/organization-list-response.dto.js';
import type { OrganizationResponseDto } from './dto/organization-response.dto.js';
import { organizationFailure, organizationNotFound } from './platform-organization-errors.js';
import { ORGANIZATION_SELECT, organizationResponse } from './platform-organization-mapping.js';
import { ORGANIZATION_TRANSACTION_OPTIONS } from './platform-organizations.constants.js';

@Injectable()
export class PlatformOrganizationsService {
	constructor(private readonly prisma: PrismaService) {}

	/** Platform control-plane lookup only; the feature module does not export this service. */
	async get(id: string): Promise<OrganizationResponseDto> {
		try {
			const row = await this.prisma.organization.findUnique({
				where: { id },
				select: ORGANIZATION_SELECT,
			});
			if (row === null) throw organizationNotFound();
			return organizationResponse(row);
		} catch (error: unknown) {
			throw organizationFailure(error);
		}
	}

	async list(query: ListOrganizationsQueryDto): Promise<OrganizationListResponseDto> {
		if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) {
			throw new BadRequestException({
				code: 'ORGANIZATION_PAGE_INVALID',
				message: 'Page size must be between 1 and 50',
			});
		}
		try {
			return await this.prisma.$transaction(
				async (transaction) => {
					const where: Prisma.OrganizationWhereInput =
						query.status === undefined
							? { status: { not: OrganizationStatus.ARCHIVED } }
							: { status: query.status };
					if (query.cursor !== undefined) {
						const cursor = await transaction.organization.findFirst({
							where: { ...where, id: query.cursor },
							select: { id: true },
						});
						if (cursor === null) {
							throw new BadRequestException({
								code: 'ORGANIZATION_CURSOR_INVALID',
								message: 'The cursor is no longer available for this filter; restart pagination',
							});
						}
					}
					// Prisma resolves the UUID cursor against database timestamps, preserving microseconds.
					const rows = await transaction.organization.findMany({
						where,
						orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
						take: query.limit + 1,
						...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
						select: ORGANIZATION_SELECT,
					});
					const page = rows.slice(0, query.limit);
					return {
						items: page.map(organizationResponse),
						nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
					};
				},
				{
					...ORGANIZATION_TRANSACTION_OPTIONS,
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
				},
			);
		} catch (error: unknown) {
			throw organizationFailure(error);
		}
	}
}
