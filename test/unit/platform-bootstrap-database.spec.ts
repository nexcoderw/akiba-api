import { jest } from '@jest/globals';

import { PLATFORM_OWNER_BOOTSTRAP_LOCK_ID } from '../../src/modules/platform/bootstrap/platform-bootstrap.constants.js';
import {
	acquireBootstrapLock,
	verifyBootstrapDatabase,
} from '../../src/modules/platform/bootstrap/platform-bootstrap-database.js';

const target = {
	databaseName: 'neondb',
	databaseRole: 'neondb_owner',
};

describe('bootstrap PostgreSQL safety boundary', () => {
	const queryRaw =
		jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>();
	const transaction = { $queryRaw: queryRaw };

	beforeEach(() => {
		queryRaw.mockReset();
	});

	it('uses the dedicated transaction lock id as a bound parameter', async () => {
		queryRaw.mockResolvedValue([{ acquired: true }]);
		await acquireBootstrapLock(transaction);
		expect(queryRaw.mock.calls[0]?.[1]).toBe(PLATFORM_OWNER_BOOTSTRAP_LOCK_ID);
		expect(queryRaw.mock.calls[0]?.[0].join('?')).toContain('pg_try_advisory_xact_lock(?::bigint)');
	});

	it.each([
		{ rows: [] },
		{ rows: [{ acquired: false }] },
		{ rows: [{ acquired: 'true' }] },
		{ rows: [{ acquired: true }, { acquired: true }] },
	])('rejects an unconfirmed lock result %j', async ({ rows }) => {
		queryRaw.mockResolvedValue(rows);
		await expect(acquireBootstrapLock(transaction)).rejects.toMatchObject({
			code: 'BOOTSTRAP_CONCURRENT_OPERATION',
		});
	});

	it.each([
		{ databaseName: 'wrong' },
		{ databaseRole: 'unexpected_user' },
		{ sessionRole: 'unexpected_user' },
	])('rejects a mismatched connected identity %j', async (override) => {
		queryRaw.mockResolvedValue([
			{
				...target,
				sessionRole: target.databaseRole,
				...override,
			},
		]);
		await expect(verifyBootstrapDatabase(transaction, target)).rejects.toMatchObject({
			code: 'BOOTSTRAP_UNSAFE_DATABASE',
		});
	});

	it.each([
		{ rows: null },
		{ rows: [] },
		{ rows: [null] },
		{ rows: [{ ...target }] },
		{ rows: [{ ...target, sessionRole: target.databaseRole }, target] },
	])('rejects an unconfirmed database identity %j', async ({ rows }) => {
		queryRaw.mockResolvedValue(rows);
		await expect(verifyBootstrapDatabase(transaction, target)).rejects.toMatchObject({
			code: 'BOOTSTRAP_UNSAFE_DATABASE',
		});
	});

	it('accepts the configured managed owner without provisioning another role', async () => {
		queryRaw.mockResolvedValue([
			{
				...target,
				sessionRole: target.databaseRole,
			},
		]);
		await expect(verifyBootstrapDatabase(transaction, target)).resolves.toBeUndefined();
	});
});
