import { loadDatabaseConfig } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from './environment.types.js';
import { parseOrganizationPortalOriginPolicy } from './organization-portal-origin.js';
import { parseOwnerInvitationDeliveryEnvironment } from './owner-invitation-delivery.environment.js';

export type OwnerInvitationWorkerEnvironment = Pick<
	EnvironmentVariables,
	| 'NODE_ENV'
	| 'OWNER_INVITATION_DELIVERY'
	| 'RESEND_API_KEY'
	| 'RESEND_FROM_EMAIL'
	| 'DATABASE_URL'
	| 'DATABASE_POOL_MAX'
	| 'DATABASE_CONNECTION_TIMEOUT_MS'
>;

/** The worker does not load HTTP authentication secrets or the API's local environment file. */
export function validateOwnerInvitationWorkerEnvironment(
	input: Record<string, unknown>,
): OwnerInvitationWorkerEnvironment {
	const environment = input.NODE_ENV;
	if (environment !== 'development' && environment !== 'test' && environment !== 'production') {
		throw new Error('NODE_ENV must be explicitly set for the invitation worker.');
	}
	const production = environment === 'production';
	const portalOriginPolicy = parseOrganizationPortalOriginPolicy(input, production);
	const settings = parseOwnerInvitationDeliveryEnvironment(input, production, portalOriginPolicy);
	if (settings === null)
		throw new Error('The invitation worker requires approved, enabled delivery.');
	const database = loadDatabaseConfig({
		DATABASE_URL: required(input.DATABASE_URL, 'DATABASE_URL'),
		DATABASE_POOL_MAX: optional(input.DATABASE_POOL_MAX),
		DATABASE_CONNECTION_TIMEOUT_MS: optional(input.DATABASE_CONNECTION_TIMEOUT_MS),
	});
	const url = new URL(database.databaseUrl);
	if (
		['neondb_owner', 'postgres', 'akiba_migrator'].includes(decodeURIComponent(url.username)) ||
		database.poolMax > 16 ||
		database.connectionTimeoutMilliseconds < 1000 ||
		database.connectionTimeoutMilliseconds > 60_000
	) {
		throw new Error('The invitation worker requires restricted, bounded database configuration.');
	}
	if (
		environment === 'production' &&
		!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')
	) {
		throw new Error('The invitation worker requires production database TLS.');
	}
	const apiKey = required(input.RESEND_API_KEY, 'RESEND_API_KEY');
	const sender = required(input.RESEND_FROM_EMAIL, 'RESEND_FROM_EMAIL');
	if (
		!/^re_[A-Za-z0-9_-]{1,256}$/u.test(apiKey) ||
		sender.length > 254 ||
		!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(sender)
	) {
		throw new Error('The invitation worker requires a valid Resend key and bare sender address.');
	}
	return Object.freeze({
		NODE_ENV: environment,
		OWNER_INVITATION_DELIVERY: settings,
		RESEND_API_KEY: apiKey,
		RESEND_FROM_EMAIL: sender,
		DATABASE_URL: database.databaseUrl,
		DATABASE_POOL_MAX: database.poolMax,
		DATABASE_CONNECTION_TIMEOUT_MS: database.connectionTimeoutMilliseconds,
	});
}

function required(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new Error(`${name} is required for the invitation worker.`);
	}
	return value;
}

function optional(value: unknown): string | undefined {
	if (value === undefined || value === '') return undefined;
	if (typeof value !== 'string') throw new Error('Worker database settings must be strings.');
	return value;
}
