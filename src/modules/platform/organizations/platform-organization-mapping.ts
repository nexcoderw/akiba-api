import type { Organization, Prisma } from '@nexcoderw/akiba-db';

import type { OrganizationResponseDto } from './dto/organization-response.dto.js';

/** Explicit allowlist: database rows and future relations never pass straight through HTTP. */
export function organizationResponse(row: Organization): OrganizationResponseDto {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		status: row.status,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		activatedAt: row.activatedAt?.toISOString() ?? null,
		suspendedAt: row.suspendedAt?.toISOString() ?? null,
		archivedAt: row.archivedAt?.toISOString() ?? null,
	};
}

export const ORGANIZATION_SELECT = Object.freeze({
	id: true,
	name: true,
	slug: true,
	status: true,
	createdAt: true,
	updatedAt: true,
	activatedAt: true,
	suspendedAt: true,
	archivedAt: true,
} satisfies Prisma.OrganizationSelect);
