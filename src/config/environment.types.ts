import type { OwnerInvitationDeliveryEnvironment } from './owner-invitation-delivery.environment.js';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Validated process configuration available through Nest's ConfigService. */
export interface EnvironmentVariables {
	readonly NODE_ENV: NodeEnvironment;
	readonly HOST: string;
	readonly PORT: number;
	readonly BODY_LIMIT_BYTES: number;
	readonly TRUST_PROXY_CIDRS: string[];
	readonly CORS_ORIGINS: string[];
	readonly SWAGGER_ENABLED: boolean;
	readonly RATE_LIMIT_TTL_MS: number;
	readonly RATE_LIMIT_LIMIT: number;
	readonly DATABASE_URL: string | null;
	readonly DATABASE_POOL_MAX: number;
	readonly DATABASE_CONNECTION_TIMEOUT_MS: number;
	readonly PLATFORM_ADMIN_ORIGIN: string;
	readonly PLATFORM_AUTH_COOKIE_SECURE: boolean;
	readonly PLATFORM_AUTH_DUMMY_PASSWORD_HASH: string;
	readonly PLATFORM_AUTH_TOKEN_PEPPER: string;
	readonly PLATFORM_AUTH_SESSION_TTL_SECONDS: number;
	readonly PLATFORM_AUTH_IDLE_TTL_SECONDS: number;
	readonly PLATFORM_AUTH_MFA_CHALLENGE_TTL_SECONDS: number;
	readonly PLATFORM_AUTH_MFA_MAX_ATTEMPTS: number;
	readonly PLATFORM_AUTH_LOGIN_ATTEMPT_WINDOW_MS: number;
	readonly PLATFORM_AUTH_LOGIN_ATTEMPT_LIMIT: number;
	readonly PLATFORM_AUTH_SINGLE_INSTANCE: boolean;
	readonly PLATFORM_AUTH_EMAIL_OTP_ENABLED: boolean;
	readonly ORGANIZATION_PORTAL_ORIGIN: string | null;
	readonly ORGANIZATION_PORTAL_BASE_DOMAIN: string | null;
	readonly OWNER_AUTH_COOKIE_SECURE: boolean;
	readonly OWNER_AUTH_TOKEN_PEPPER: string;
	readonly OWNER_ENROLLMENT_TOKEN_PEPPER: string;
	readonly OWNER_AUTH_SESSION_TTL_SECONDS: number;
	readonly OWNER_AUTH_IDLE_TTL_SECONDS: number;
	readonly OWNER_ENROLLMENT_CHALLENGE_TTL_SECONDS: number;
	readonly OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS: number;
	readonly OWNER_AUTH_LOGIN_ATTEMPT_LIMIT: number;
	readonly OWNER_INVITATION_DELIVERY: OwnerInvitationDeliveryEnvironment | null;
	readonly RESEND_API_KEY: string | null;
	readonly RESEND_FROM_EMAIL: string | null;
	readonly PLATFORM_TOTP_KEYRING: Readonly<Record<string, string>>;
	readonly PLATFORM_TOTP_ACTIVE_KEY_ID: string;
	readonly PLATFORM_OWNER_BOOTSTRAP_ENABLED: boolean;
}
