export type PlatformBootstrapStage = 'initialize' | 'activate';

export type PlatformBootstrapErrorCode =
	| 'BOOTSTRAP_DISABLED'
	| 'BOOTSTRAP_INVALID_INPUT'
	| 'BOOTSTRAP_ALREADY_INITIALIZED'
	| 'BOOTSTRAP_IDENTITY_CONFLICT'
	| 'BOOTSTRAP_ROLE_CONFLICT'
	| 'BOOTSTRAP_STATE_CONFLICT'
	| 'BOOTSTRAP_CONCURRENT_OPERATION'
	| 'BOOTSTRAP_UNSAFE_DATABASE'
	| 'BOOTSTRAP_ENROLLMENT_UNAVAILABLE'
	| 'BOOTSTRAP_DATABASE_FAILED';

export class PlatformBootstrapError extends Error {
	override readonly name = 'PlatformBootstrapError';

	constructor(
		readonly code: PlatformBootstrapErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export interface PlatformBootstrapTarget {
	readonly environment: string;
	readonly databaseHost: string;
	readonly databaseRole: string;
	readonly databaseName: string;
}

export interface InitializePlatformOwnerInput {
	readonly email: string;
	readonly displayName: string;
}
