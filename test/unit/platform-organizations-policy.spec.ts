import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrganizationStatus } from '@nexcoderw/akiba-db';

import { CreateOrganizationDto } from '../../src/modules/platform/organizations/dto/create-organization.dto.js';
import { UpdateOrganizationDto } from '../../src/modules/platform/organizations/dto/update-organization.dto.js';
import { ListOrganizationsQueryDto } from '../../src/modules/platform/organizations/dto/list-organizations-query.dto.js';
import { lifecycleStatus } from '../../src/modules/platform/organizations/platform-organization-lifecycle.js';
import { organizationResponse } from '../../src/modules/platform/organizations/platform-organization-mapping.js';
import { organizationFailure } from '../../src/modules/platform/organizations/platform-organization-errors.js';
import { organizationPrecondition } from '../../src/modules/platform/organizations/platform-organization-preconditions.js';
import { ORGANIZATION_RESERVED_SLUGS } from '../../src/modules/platform/organizations/platform-organizations.constants.js';
import { organizationFixture } from '../fixtures/platform-organizations-database.fixture.js';

describe('platform organization policies and transport DTOs', () => {
	it('normalizes only name edges and preserves explicit safe response fields', async () => {
		const input = plainToInstance(CreateOrganizationDto, {
			name: '  Kimihurura Supplies\u0085 ',
			slug: 'kimihurura',
		});
		expect(await validate(input)).toEqual([]);
		expect(input.name).toBe('Kimihurura Supplies');
		const row = organizationFixture();
		const result = organizationResponse({ ...row, ...{ secret: 'not a response field' } });
		expect(Object.keys(result).sort()).toEqual(
			[
				'id',
				'name',
				'slug',
				'status',
				'createdAt',
				'updatedAt',
				'activatedAt',
				'suspendedAt',
				'archivedAt',
			].sort(),
		);
		expect(result.status).toBe('PENDING');
		expect(result.activatedAt).toBeNull();
	});

	it.each(['', ' ', '\u0085', 'Kimihurura Supplies\u0000organization', 'x'.repeat(161)])(
		'rejects invalid names: %#',
		async (name) => {
			expect(
				await validate(plainToInstance(CreateOrganizationDto, { name, slug: 'kimihurura' })),
			).not.toEqual([]);
		},
	);
	it.each([
		'Abc',
		'ab',
		'-abc',
		'abc-',
		'a--bc',
		'a_bc',
		'école',
		'abc\n',
		'a'.repeat(64),
		...ORGANIZATION_RESERVED_SLUGS,
	])('rejects invalid or reserved slug: %s', async (slug) => {
		expect(
			await validate(plainToInstance(CreateOrganizationDto, { name: 'Kimihurura Supplies', slug })),
		).not.toEqual([]);
	});
	it.each(['status', 'slug', 'id', 'activatedAt', 'ownerId', 'metadata'])(
		'rejects profile mass assignment: %s',
		async (field) => {
			const input = plainToInstance(UpdateOrganizationDto, {
				name: 'Remera Trading',
				[field]: 'untrusted',
			});
			expect(await validate(input, { whitelist: true, forbidNonWhitelisted: true })).not.toEqual(
				[],
			);
		},
	);
	it.each(['status', 'ownerId', 'userId', 'platformStaffId', 'metadata'])(
		'rejects creation ownership or activation fields: %s',
		async (field) => {
			const input = plainToInstance(CreateOrganizationDto, {
				name: 'Kimihurura Supplies',
				slug: 'kimihurura',
				[field]: 'untrusted',
			});
			expect(await validate(input, { whitelist: true, forbidNonWhitelisted: true })).not.toEqual(
				[],
			);
		},
	);
	it.each(['0', '51', '-1', '1.5', '1e1', ' 20 ', ['20']])(
		'rejects malformed page size: %#',
		async (limit) => {
			expect(await validate(plainToInstance(ListOrganizationsQueryDto, { limit }))).not.toEqual([]);
		},
	);
	it('accepts bounded filters and rejects malformed cursors and statuses', async () => {
		const query = plainToInstance(ListOrganizationsQueryDto, { limit: '50', status: 'ACTIVE' });
		expect(await validate(query)).toEqual([]);
		expect(query.limit).toBe(50);
		expect(
			(
				await validate(
					plainToInstance(ListOrganizationsQueryDto, { cursor: 'bad', status: 'enabled' }),
				)
			).length,
		).toBe(2);
	});
	it.each(Object.values(OrganizationStatus))(
		'defines exact lifecycle outcomes from %s',
		(status) => {
			if (status === OrganizationStatus.PENDING || status === OrganizationStatus.SUSPENDED) {
				expect(lifecycleStatus(status, 'activation')).toBe(OrganizationStatus.ACTIVE);
			} else expect(() => lifecycleStatus(status, 'activation')).toThrow();
			if (status === OrganizationStatus.ACTIVE)
				expect(lifecycleStatus(status, 'suspension')).toBe(OrganizationStatus.SUSPENDED);
			else expect(() => lifecycleStatus(status, 'suspension')).toThrow();
			if (status !== OrganizationStatus.ARCHIVED)
				expect(lifecycleStatus(status, 'archival')).toBe(OrganizationStatus.ARCHIVED);
			else expect(() => lifecycleStatus(status, 'archival')).toThrow();
		},
	);
	it('validates quoted preconditions without coerced arrays or wildcard tags', () => {
		expect(organizationPrecondition('"2026-10-13T12:00:00.000Z"').toISOString()).toBe(
			'2026-10-13T12:00:00.000Z',
		);
		for (const value of [
			undefined,
			'*',
			['"2026-10-13T12:00:00.000Z"'],
			'"2026-02-30T12:00:00.000Z"',
		]) {
			expect(() => organizationPrecondition(value)).toThrow();
		}
	});
	it('translates conflicts and hides arbitrary provider failure details', () => {
		expect(organizationFailure({ code: 'P2002', message: 'private SQL' }).getStatus()).toBe(409);
		expect(organizationFailure({ code: 'P2034' }).getStatus()).toBe(412);
		expect(organizationFailure(new Error('secret')).getResponse()).not.toHaveProperty('secret');
	});
});
