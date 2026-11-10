import { jest } from '@jest/globals';

import { PLATFORM_OWNER_BOOTSTRAP_LOCK_ID } from '../../src/modules/platform/bootstrap/platform-bootstrap.constants.js';
import {
	acquireBootstrapLock,
	verifyBootstrapDatabase,
} from '../../src/modules/platform/bootstrap/platform-bootstrap-database.js';

const target = {
	databaseName: 'akiba_bootstrap_test',
	databaseRole: 'akiba_bootstrap_test',
	databaseMarker: 'akiba:disposable-bootstrap-test:724fbc40-515c-4a30-a4bb-8a6458a24396',
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
		{ databaseRole: 'akiba_app' },
		{ sessionRole: 'neondb_owner' },
		{ databaseMarker: null },
		{ unsafeRole: true },
		{ canCreate: true },
		{ ownsObjects: true },
		{ unsafeRole: undefined },
	])('rejects unsafe connected identity %j', async (override) => {
		queryRaw.mockResolvedValue([
			{
				...target,
				sessionRole: target.databaseRole,
				unsafeRole: false,
				canCreate: false,
				ownsObjects: false,
				...override,
			},
		]);
		await expect(verifyBootstrapDatabase(transaction, target)).rejects.toMatchObject({
			code: 'BOOTSTRAP_UNSAFE_DATABASE',
		});
	});

	it('accepts only the expected connected identity with restricted privileges', async () => {
		queryRaw.mockResolvedValue([
			{
				...target,
				sessionRole: target.databaseRole,
				unsafeRole: false,
				canCreate: false,
				ownsObjects: false,
			},
		]);
		await expect(verifyBootstrapDatabase(transaction, target)).resolves.toBeUndefined();
	});
});
