import { PLATFORM_OWNER_BOOTSTRAP_LOCK_ID } from './platform-bootstrap.constants.js';
import { PlatformBootstrapError } from './platform-bootstrap.types.js';

export interface BootstrapDatabaseTarget {
	readonly databaseName: string;
	readonly databaseRole: string;
}

interface BootstrapQueryClient {
	$queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** A transaction lock returns a supported boolean rather than PostgreSQL's void type. */
export async function acquireBootstrapLock(transaction: BootstrapQueryClient): Promise<void> {
	const rows = await transaction.$queryRaw`
		SELECT pg_try_advisory_xact_lock(${PLATFORM_OWNER_BOOTSTRAP_LOCK_ID}::bigint) AS acquired
	`;
	const result: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
	if (
		typeof result !== 'object' ||
		result === null ||
		!('acquired' in result) ||
		result.acquired !== true
	) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_CONCURRENT_OPERATION',
			'Another bootstrap transaction holds the lock; review its outcome before retrying.',
		);
	}
}

/** Verify the actual backend and effective role in the same transaction as privileged writes. */
export async function verifyBootstrapDatabase(
	transaction: BootstrapQueryClient,
	target: BootstrapDatabaseTarget,
): Promise<void> {
	const rows: unknown = await transaction.$queryRaw`
		SELECT current_database()::text AS "databaseName",
			current_user::text AS "databaseRole", session_user::text AS "sessionRole"
	`;
	const identity: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
	if (
		typeof identity !== 'object' ||
		identity === null ||
		!('databaseName' in identity) ||
		!('databaseRole' in identity) ||
		!('sessionRole' in identity) ||
		identity.databaseName !== target.databaseName ||
		identity.databaseRole !== target.databaseRole ||
		identity.sessionRole !== target.databaseRole
	) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_UNSAFE_DATABASE',
			'The connected database identity does not match the configured environment connection.',
		);
	}
}
