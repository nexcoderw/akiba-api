import { isIP } from 'node:net';
import {
	NODE_ENVIRONMENTS,
	type EnvironmentVariables,
	type NodeEnvironment,
} from './environment.types.js';
import { parseOrganizationPortalOriginPolicy } from './organization-portal-origin.js';
import { parseOwnerInvitationDeliveryEnvironment } from './owner-invitation-delivery.environment.js';

const DEFAULT_PORT = 3000;
const DEFAULT_RATE_LIMIT_TTL_MS = 60_000;
const DEFAULT_RATE_LIMIT_LIMIT = 100;
const DEFAULT_LOCAL_ORIGIN = 'http://localhost:4000';
const DEFAULT_MANAGER_ORIGIN = 'http://localhost:4001';
const DEFAULT_LOCAL_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DEFAULT_DUMMY_PASSWORD_HASH =
	'$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function requireString(value: unknown, name: string, fallback?: string): string {
	if (value === undefined || value === '') {
		if (fallback !== undefined) {
			return fallback;
		}
		throw new Error(`${name} is required.`);
	}
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${name} must be a non-empty string.`);
	}
	return value.trim();
}

function parseInteger(
	value: unknown,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || value === '') {
		return fallback;
	}

	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
		);
	}
	return parsed;
}

function parseBoolean(value: unknown, name: string, fallback: boolean): boolean {
	if (value === undefined || value === '') {
		return fallback;
	}
	if (value === true || value === 'true') {
		return true;
	}
	if (value === false || value === 'false') {
		return false;
	}
	throw new Error(`${name} must be either true or false.`);
}

function parseNodeEnvironment(value: unknown): NodeEnvironment {
	const environment = value ?? 'development';
	if (typeof environment !== 'string' || !isNodeEnvironment(environment)) {
		throw new Error(`NODE_ENV must be one of: ${NODE_ENVIRONMENTS.join(', ')}.`);
	}
	return environment;
}

function isNodeEnvironment(value: string): value is NodeEnvironment {
	return NODE_ENVIRONMENTS.some((environment) => environment === value);
}

function parseOrigins(value: unknown, environment: NodeEnvironment): string[] {
	const rawOrigins = typeof value === 'string' ? value : '';
	const candidates = rawOrigins
		.split(',')
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);

	if (candidates.length === 0) {
		if (environment === 'production') {
			throw new Error('CORS_ORIGINS is required in production.');
		}
		return [DEFAULT_LOCAL_ORIGIN, DEFAULT_MANAGER_ORIGIN];
	}

	return candidates.map((candidate) => {
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			throw new Error('CORS_ORIGINS must contain valid absolute origins.');
		}
		if (url.origin !== candidate || !['http:', 'https:'].includes(url.protocol)) {
			throw new Error('CORS_ORIGINS must contain HTTP origins without paths.');
		}
		if (environment === 'production' && url.protocol !== 'https:') {
			throw new Error('CORS_ORIGINS must use HTTPS in production.');
		}
		return url.origin;
	});
}

function parseOrigin(value: unknown, name: string, fallback?: string): string {
	const candidate = requireString(value, name, fallback);
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error(`${name} must be a valid absolute origin.`);
	}
	if (url.origin !== candidate || !['http:', 'https:'].includes(url.protocol)) {
		throw new Error(`${name} must be an HTTP origin without a path.`);
	}
	return url.origin;
}

function parseBase64Key(value: unknown, name: string, fallback?: string): string {
	const encoded = requireString(value, name, fallback);
	const decoded = Buffer.from(encoded, 'base64');
	if (decoded.length !== 32 || decoded.toString('base64') !== encoded) {
		throw new Error(`${name} must be a canonical base64-encoded 32-byte key.`);
	}
	return encoded;
}

function parseTotpKeyring(
	value: unknown,
	environment: NodeEnvironment,
): Readonly<Record<string, string>> {
	const raw = requireString(
		value,
		'PLATFORM_TOTP_KEYRING',
		environment === 'production' ? undefined : `local-v1=${DEFAULT_LOCAL_KEY}`,
	);
	const entries = raw.split(',').map((entry) => entry.trim());
	const keyring: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf('=');
		const keyId = separator < 0 ? '' : entry.slice(0, separator);
		const encodedKey = separator < 0 ? '' : entry.slice(separator + 1);
		if (!/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(keyId) || keyring[keyId] !== undefined) {
			throw new Error('PLATFORM_TOTP_KEYRING contains an invalid or duplicate key identifier.');
		}
		keyring[keyId] = parseBase64Key(encodedKey, `PLATFORM_TOTP_KEYRING key ${keyId}`);
	}
	return Object.freeze(keyring);
}

function parseTrustedProxies(value: unknown): string[] {
	if (value === undefined || value === '') return [];
	if (typeof value !== 'string')
		throw new Error('TRUST_PROXY_CIDRS must be an explicit IP/CIDR list.');
	const entries = value.split(',').map((entry) => entry.trim());
	if (
		entries.length > 16 ||
		entries.some((entry) => {
			const parts = entry.split('/');
			const address = parts[0] ?? '';
			const version = isIP(address);
			const prefix = parts[1];
			return (
				version === 0 ||
				parts.length > 2 ||
				(prefix !== undefined &&
					(!/^[0-9]{1,3}$/u.test(prefix) ||
						Number(prefix) < 1 ||
						Number(prefix) > (version === 4 ? 32 : 128)))
			);
		})
	)
		throw new Error(
			'TRUST_PROXY_CIDRS must contain bounded IP/CIDR ranges, never trust-all settings.',
		);
	return entries;
}

/** Validates and normalizes environment variables before Nest creates application providers. */
export function validateEnvironment(input: Record<string, unknown>): EnvironmentVariables {
	const nodeEnvironment = parseNodeEnvironment(input.NODE_ENV);
	const host = input.HOST;
	if (host !== undefined && (typeof host !== 'string' || host.trim() === '')) {
		throw new Error('HOST must be a non-empty string.');
	}

	const corsOrigins = parseOrigins(input.CORS_ORIGINS, nodeEnvironment);
	const platformAdminOrigin = parseOrigin(
		input.PLATFORM_ADMIN_ORIGIN,
		'PLATFORM_ADMIN_ORIGIN',
		nodeEnvironment === 'production' ? undefined : DEFAULT_LOCAL_ORIGIN,
	);
	if (!corsOrigins.includes(platformAdminOrigin)) {
		throw new Error('PLATFORM_ADMIN_ORIGIN must also be present in CORS_ORIGINS.');
	}
	if (nodeEnvironment === 'production' && !platformAdminOrigin.startsWith('https://')) {
		throw new Error('PLATFORM_ADMIN_ORIGIN must use HTTPS in production.');
	}

	const cookieSecure = parseBoolean(
		input.PLATFORM_AUTH_COOKIE_SECURE,
		'PLATFORM_AUTH_COOKIE_SECURE',
		nodeEnvironment === 'production',
	);
	if (nodeEnvironment === 'production' && !cookieSecure) {
		throw new Error('PLATFORM_AUTH_COOKIE_SECURE must be true in production.');
	}

	const singleInstance = parseBoolean(
		input.PLATFORM_AUTH_SINGLE_INSTANCE,
		'PLATFORM_AUTH_SINGLE_INSTANCE',
		nodeEnvironment !== 'production',
	);
	if (nodeEnvironment === 'production' && !singleInstance) {
		throw new Error(
			'Production requires PLATFORM_AUTH_SINGLE_INSTANCE=true until distributed authentication throttling is implemented.',
		);
	}

	const tokenPepper = parseBase64Key(
		input.PLATFORM_AUTH_TOKEN_PEPPER,
		'PLATFORM_AUTH_TOKEN_PEPPER',
		nodeEnvironment === 'production' ? undefined : DEFAULT_LOCAL_KEY,
	);
	if (nodeEnvironment === 'production' && tokenPepper === DEFAULT_LOCAL_KEY) {
		throw new Error('PLATFORM_AUTH_TOKEN_PEPPER must not use the local development key.');
	}

	const totpKeyring = parseTotpKeyring(input.PLATFORM_TOTP_KEYRING, nodeEnvironment);
	if (nodeEnvironment === 'production' && Object.values(totpKeyring).includes(DEFAULT_LOCAL_KEY)) {
		throw new Error('PLATFORM_TOTP_KEYRING must not contain the local development key.');
	}
	const activeTotpKeyId = requireString(
		input.PLATFORM_TOTP_ACTIVE_KEY_ID,
		'PLATFORM_TOTP_ACTIVE_KEY_ID',
		nodeEnvironment === 'production' ? undefined : 'local-v1',
	);
	if (totpKeyring[activeTotpKeyId] === undefined) {
		throw new Error('PLATFORM_TOTP_ACTIVE_KEY_ID must identify a configured TOTP key.');
	}

	// Offline tests replace the database module; no synthetic connection URL is configured.
	const databaseUrl =
		nodeEnvironment === 'test' ? null : requireString(input.DATABASE_URL, 'DATABASE_URL');
	if (databaseUrl !== null) {
		let parsedDatabaseUrl: URL;
		try {
			parsedDatabaseUrl = new URL(databaseUrl);
		} catch {
			throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
		}
		if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
			throw new Error('DATABASE_URL must use PostgreSQL.');
		}
		if (
			!parsedDatabaseUrl.hostname ||
			!parsedDatabaseUrl.username ||
			!parsedDatabaseUrl.password ||
			parsedDatabaseUrl.pathname === '' ||
			parsedDatabaseUrl.pathname === '/'
		) {
			throw new Error('DATABASE_URL must specify the configured host, database and credentials.');
		}
		if (
			!['require', 'verify-ca', 'verify-full'].includes(
				parsedDatabaseUrl.searchParams.get('sslmode') ?? '',
			)
		) {
			throw new Error('DATABASE_URL must require TLS.');
		}
	}
	const swaggerEnabled = parseBoolean(
		input.SWAGGER_ENABLED,
		'SWAGGER_ENABLED',
		nodeEnvironment !== 'production',
	);
	if (nodeEnvironment === 'production' && swaggerEnabled)
		throw new Error(
			'SWAGGER_ENABLED must be false in production until documentation authentication is implemented.',
		);
	const bootstrapEnabled = parseBoolean(
		input.PLATFORM_OWNER_BOOTSTRAP_ENABLED,
		'PLATFORM_OWNER_BOOTSTRAP_ENABLED',
		false,
	);
	if (bootstrapEnabled && nodeEnvironment === 'test') {
		throw new Error('Platform owner bootstrap requires the development or production environment.');
	}

	const sessionTtlSeconds = parseInteger(
		input.PLATFORM_AUTH_SESSION_TTL_SECONDS,
		'PLATFORM_AUTH_SESSION_TTL_SECONDS',
		28_800,
		300,
		86_400,
	);
	const idleTtlSeconds = parseInteger(
		input.PLATFORM_AUTH_IDLE_TTL_SECONDS,
		'PLATFORM_AUTH_IDLE_TTL_SECONDS',
		1_800,
		60,
		14_400,
	);
	if (idleTtlSeconds > sessionTtlSeconds) {
		throw new Error('PLATFORM_AUTH_IDLE_TTL_SECONDS must not exceed the session lifetime.');
	}

	const emailOtpEnabled = parseBoolean(
		input.PLATFORM_AUTH_EMAIL_OTP_ENABLED,
		'PLATFORM_AUTH_EMAIL_OTP_ENABLED',
		false,
	);
	const organizationPortalPolicy = parseOrganizationPortalOriginPolicy(
		input,
		nodeEnvironment === 'production',
		DEFAULT_MANAGER_ORIGIN,
	);
	if (
		organizationPortalPolicy.fixedOrigin !== null &&
		!corsOrigins.includes(organizationPortalPolicy.fixedOrigin)
	) {
		throw new Error('ORGANIZATION_PORTAL_ORIGIN must also be present in CORS_ORIGINS.');
	}
	const ownerCookieSecure = parseBoolean(
		input.OWNER_AUTH_COOKIE_SECURE,
		'OWNER_AUTH_COOKIE_SECURE',
		nodeEnvironment === 'production',
	);
	if (nodeEnvironment === 'production' && !ownerCookieSecure) {
		throw new Error('OWNER_AUTH_COOKIE_SECURE must be true in production.');
	}
	const ownerTokenPepper = parseBase64Key(
		input.OWNER_AUTH_TOKEN_PEPPER,
		'OWNER_AUTH_TOKEN_PEPPER',
		nodeEnvironment === 'production' ? undefined : DEFAULT_LOCAL_KEY,
	);
	const ownerEnrollmentTokenPepper = parseBase64Key(
		input.OWNER_ENROLLMENT_TOKEN_PEPPER,
		'OWNER_ENROLLMENT_TOKEN_PEPPER',
		nodeEnvironment === 'production' ? undefined : DEFAULT_LOCAL_KEY,
	);
	if (
		nodeEnvironment === 'production' &&
		(ownerTokenPepper === DEFAULT_LOCAL_KEY || ownerEnrollmentTokenPepper === DEFAULT_LOCAL_KEY)
	) {
		throw new Error('Owner authentication keys must not use the local development key.');
	}
	if (
		nodeEnvironment === 'production' &&
		(ownerTokenPepper === tokenPepper || ownerEnrollmentTokenPepper === tokenPepper)
	) {
		throw new Error('Owner authentication keys must not reuse the platform token pepper.');
	}
	if (ownerTokenPepper === ownerEnrollmentTokenPepper && nodeEnvironment === 'production') {
		throw new Error('Owner session and enrollment tokens require independent keys.');
	}
	const ownerSessionTtlSeconds = parseInteger(
		input.OWNER_AUTH_SESSION_TTL_SECONDS,
		'OWNER_AUTH_SESSION_TTL_SECONDS',
		28_800,
		300,
		2_592_000,
	);
	const ownerIdleTtlSeconds = parseInteger(
		input.OWNER_AUTH_IDLE_TTL_SECONDS,
		'OWNER_AUTH_IDLE_TTL_SECONDS',
		1_800,
		60,
		86_400,
	);
	if (ownerIdleTtlSeconds > ownerSessionTtlSeconds) {
		throw new Error('OWNER_AUTH_IDLE_TTL_SECONDS must not exceed the session lifetime.');
	}
	const invitationDelivery = parseOwnerInvitationDeliveryEnvironment(
		input,
		nodeEnvironment === 'production',
		organizationPortalPolicy,
	);
	if (invitationDelivery !== null) {
		const invitationSecrets = [
			invitationDelivery.hmacSecret,
			...Object.values(invitationDelivery.encryptionKeys),
		];
		if (
			invitationSecrets.includes(tokenPepper) ||
			invitationSecrets.includes(ownerTokenPepper) ||
			invitationSecrets.includes(ownerEnrollmentTokenPepper) ||
			Object.values(totpKeyring).some((key) => invitationSecrets.includes(key))
		) {
			throw new Error(
				'Owner invitation keys must not reuse authentication, enrollment, or TOTP keys.',
			);
		}
	}
	const resendRequired = emailOtpEnabled || invitationDelivery !== null;
	const resendApiKey = resendRequired
		? requireString(input.RESEND_API_KEY, 'RESEND_API_KEY')
		: null;
	const resendFromEmail = resendRequired
		? requireString(input.RESEND_FROM_EMAIL, 'RESEND_FROM_EMAIL')
		: null;
	if (resendApiKey !== null && !/^re_[A-Za-z0-9_-]{1,256}$/u.test(resendApiKey)) {
		throw new Error('RESEND_API_KEY must be a valid Resend API key.');
	}
	if (
		resendFromEmail !== null &&
		(resendFromEmail.length > 254 ||
			!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(
				resendFromEmail,
			))
	) {
		throw new Error('RESEND_FROM_EMAIL must be a bare email address on a verified sender domain.');
	}
	return Object.freeze({
		NODE_ENV: nodeEnvironment,
		HOST: typeof host === 'string' ? host : '127.0.0.1',
		PORT: parseInteger(input.PORT, 'PORT', DEFAULT_PORT, 1, 65_535),
		BODY_LIMIT_BYTES: parseInteger(
			input.BODY_LIMIT_BYTES,
			'BODY_LIMIT_BYTES',
			32_768,
			1024,
			1_048_576,
		),
		TRUST_PROXY_CIDRS: parseTrustedProxies(input.TRUST_PROXY_CIDRS),
		CORS_ORIGINS: corsOrigins,
		SWAGGER_ENABLED: swaggerEnabled,
		RATE_LIMIT_TTL_MS: parseInteger(
			input.RATE_LIMIT_TTL_MS,
			'RATE_LIMIT_TTL_MS',
			DEFAULT_RATE_LIMIT_TTL_MS,
			1_000,
			3_600_000,
		),
		RATE_LIMIT_LIMIT: parseInteger(
			input.RATE_LIMIT_LIMIT,
			'RATE_LIMIT_LIMIT',
			DEFAULT_RATE_LIMIT_LIMIT,
			1,
			100_000,
		),
		DATABASE_URL: databaseUrl,
		DATABASE_POOL_MAX: parseInteger(input.DATABASE_POOL_MAX, 'DATABASE_POOL_MAX', 10, 1, 100),
		DATABASE_CONNECTION_TIMEOUT_MS: parseInteger(
			input.DATABASE_CONNECTION_TIMEOUT_MS,
			'DATABASE_CONNECTION_TIMEOUT_MS',
			10_000,
			1_000,
			60_000,
		),
		PLATFORM_ADMIN_ORIGIN: platformAdminOrigin,
		PLATFORM_AUTH_COOKIE_SECURE: cookieSecure,
		PLATFORM_AUTH_DUMMY_PASSWORD_HASH: requireString(
			input.PLATFORM_AUTH_DUMMY_PASSWORD_HASH,
			'PLATFORM_AUTH_DUMMY_PASSWORD_HASH',
			nodeEnvironment === 'production' ? undefined : DEFAULT_DUMMY_PASSWORD_HASH,
		),
		PLATFORM_AUTH_TOKEN_PEPPER: tokenPepper,
		PLATFORM_AUTH_SESSION_TTL_SECONDS: sessionTtlSeconds,
		PLATFORM_AUTH_IDLE_TTL_SECONDS: idleTtlSeconds,
		PLATFORM_AUTH_MFA_CHALLENGE_TTL_SECONDS: parseInteger(
			input.PLATFORM_AUTH_MFA_CHALLENGE_TTL_SECONDS,
			'PLATFORM_AUTH_MFA_CHALLENGE_TTL_SECONDS',
			300,
			60,
			900,
		),
		PLATFORM_AUTH_MFA_MAX_ATTEMPTS: parseInteger(
			input.PLATFORM_AUTH_MFA_MAX_ATTEMPTS,
			'PLATFORM_AUTH_MFA_MAX_ATTEMPTS',
			5,
			1,
			10,
		),
		PLATFORM_AUTH_LOGIN_ATTEMPT_WINDOW_MS: parseInteger(
			input.PLATFORM_AUTH_LOGIN_ATTEMPT_WINDOW_MS,
			'PLATFORM_AUTH_LOGIN_ATTEMPT_WINDOW_MS',
			900_000,
			60_000,
			3_600_000,
		),
		PLATFORM_AUTH_LOGIN_ATTEMPT_LIMIT: parseInteger(
			input.PLATFORM_AUTH_LOGIN_ATTEMPT_LIMIT,
			'PLATFORM_AUTH_LOGIN_ATTEMPT_LIMIT',
			5,
			1,
			20,
		),
		PLATFORM_AUTH_SINGLE_INSTANCE: singleInstance,
		PLATFORM_AUTH_EMAIL_OTP_ENABLED: emailOtpEnabled,
		ORGANIZATION_PORTAL_ORIGIN: organizationPortalPolicy.fixedOrigin,
		ORGANIZATION_PORTAL_BASE_DOMAIN: organizationPortalPolicy.baseDomain,
		OWNER_AUTH_COOKIE_SECURE: ownerCookieSecure,
		OWNER_AUTH_TOKEN_PEPPER: ownerTokenPepper,
		OWNER_ENROLLMENT_TOKEN_PEPPER: ownerEnrollmentTokenPepper,
		OWNER_AUTH_SESSION_TTL_SECONDS: ownerSessionTtlSeconds,
		OWNER_AUTH_IDLE_TTL_SECONDS: ownerIdleTtlSeconds,
		OWNER_ENROLLMENT_CHALLENGE_TTL_SECONDS: parseInteger(
			input.OWNER_ENROLLMENT_CHALLENGE_TTL_SECONDS,
			'OWNER_ENROLLMENT_CHALLENGE_TTL_SECONDS',
			600,
			60,
			900,
		),
		OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS: parseInteger(
			input.OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS,
			'OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS',
			900_000,
			60_000,
			3_600_000,
		),
		OWNER_AUTH_LOGIN_ATTEMPT_LIMIT: parseInteger(
			input.OWNER_AUTH_LOGIN_ATTEMPT_LIMIT,
			'OWNER_AUTH_LOGIN_ATTEMPT_LIMIT',
			5,
			1,
			20,
		),
		OWNER_INVITATION_DELIVERY: invitationDelivery,
		RESEND_API_KEY: resendApiKey,
		RESEND_FROM_EMAIL: resendFromEmail,
		PLATFORM_TOTP_KEYRING: totpKeyring,
		PLATFORM_TOTP_ACTIVE_KEY_ID: activeTotpKeyId,
		PLATFORM_OWNER_BOOTSTRAP_ENABLED: bootstrapEnabled,
	});
}
