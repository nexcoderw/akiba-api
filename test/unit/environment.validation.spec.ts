import { validateEnvironment } from '../../src/config/environment.validation.js';

describe('validateEnvironment', () => {
	it('returns safe offline test defaults', () => {
		expect(validateEnvironment({ NODE_ENV: 'test' })).toEqual({
			NODE_ENV: 'test',
			API_PUBLIC_ORIGIN: 'http://localhost:3000',
			HOST: '127.0.0.1',
			PORT: 3000,
			BODY_LIMIT_BYTES: 32768,
			TRUST_PROXY_CIDRS: [],
			CORS_ORIGINS: ['http://localhost:4000', 'http://localhost:4001'],
			SWAGGER_ENABLED: true,
			RATE_LIMIT_TTL_MS: 60_000,
			RATE_LIMIT_LIMIT: 100,
			DATABASE_URL: null,
			DATABASE_POOL_MAX: 10,
			DATABASE_CONNECTION_TIMEOUT_MS: 10_000,
			PLATFORM_ADMIN_ORIGIN: 'http://localhost:4000',
			PLATFORM_AUTH_COOKIE_SECURE: false,
			PLATFORM_AUTH_DUMMY_PASSWORD_HASH:
				'$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			PLATFORM_AUTH_TOKEN_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			PLATFORM_AUTH_SESSION_TTL_SECONDS: 28_800,
			PLATFORM_AUTH_IDLE_TTL_SECONDS: 1_800,
			PLATFORM_AUTH_MFA_CHALLENGE_TTL_SECONDS: 300,
			PLATFORM_AUTH_MFA_MAX_ATTEMPTS: 5,
			PLATFORM_AUTH_LOGIN_ATTEMPT_WINDOW_MS: 900_000,
			PLATFORM_AUTH_LOGIN_ATTEMPT_LIMIT: 5,
			PLATFORM_AUTH_SINGLE_INSTANCE: true,
			PLATFORM_AUTH_EMAIL_OTP_ENABLED: false,
			ORGANIZATION_PORTAL_ORIGIN: 'http://localhost:4001',
			ORGANIZATION_PORTAL_BASE_DOMAIN: null,
			OWNER_AUTH_COOKIE_SECURE: false,
			OWNER_AUTH_TOKEN_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			OWNER_ENROLLMENT_TOKEN_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			OWNER_AUTH_SESSION_TTL_SECONDS: 28_800,
			OWNER_AUTH_IDLE_TTL_SECONDS: 1_800,
			OWNER_ENROLLMENT_CHALLENGE_TTL_SECONDS: 600,
			OWNER_AUTH_LOGIN_ATTEMPT_WINDOW_MS: 900_000,
			OWNER_AUTH_LOGIN_ATTEMPT_LIMIT: 5,
			OWNER_INVITATION_DELIVERY: null,
			RESEND_API_KEY: null,
			RESEND_FROM_EMAIL: null,
			PLATFORM_TOTP_KEYRING: {
				'local-v1': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			},
			PLATFORM_TOTP_ACTIVE_KEY_ID: 'local-v1',
			PLATFORM_OWNER_BOOTSTRAP_ENABLED: false,
		});
	});

	it('requires Resend credentials only when email verification is enabled', () => {
		expect(() =>
			validateEnvironment({ NODE_ENV: 'test', PLATFORM_AUTH_EMAIL_OTP_ENABLED: 'true' }),
		).toThrow('RESEND_API_KEY');
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'test',
				PLATFORM_AUTH_EMAIL_OTP_ENABLED: 'true',
				RESEND_API_KEY: 're_fictional',
				RESEND_FROM_EMAIL: 'invalid',
			}),
		).toThrow('RESEND_FROM_EMAIL');
		expect(
			validateEnvironment({
				NODE_ENV: 'test',
				PLATFORM_AUTH_EMAIL_OTP_ENABLED: 'true',
				RESEND_API_KEY: 're_fictional',
				RESEND_FROM_EMAIL: 'security@example.com',
			}).PLATFORM_AUTH_EMAIL_OTP_ENABLED,
		).toBe(true);
	});

	it('preserves an explicitly configured port and rejects the old admin origin', () => {
		expect(validateEnvironment({ NODE_ENV: 'test', PORT: '3100' }).PORT).toBe(3100);
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'test',
				CORS_ORIGINS: 'http://localhost:4000,http://localhost:4001',
				PLATFORM_ADMIN_ORIGIN: 'http://localhost:3000',
			}),
		).toThrow('PLATFORM_ADMIN_ORIGIN must also be present in CORS_ORIGINS.');
	});

	it('requires explicit production origins', () => {
		expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
			'CORS_ORIGINS is required in production.',
		);
	});

	it('requires a real runtime URL outside offline tests', () => {
		expect(() => validateEnvironment({ NODE_ENV: 'development' })).toThrow(
			'DATABASE_URL is required.',
		);
	});

	it.each(['true', '*', '0.0.0.0/0', '::/0', '1', 'ingress.example.com'])(
		'rejects broad proxy trust %s',
		(value) => {
			expect(() => validateEnvironment({ NODE_ENV: 'test', TRUST_PROXY_CIDRS: value })).toThrow(
				'TRUST_PROXY_CIDRS',
			);
		},
	);

	it('accepts explicit proxy ranges and bounded body limits', () => {
		const config = validateEnvironment({
			NODE_ENV: 'test',
			TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128',
			BODY_LIMIT_BYTES: '65536',
		});
		expect(config.TRUST_PROXY_CIDRS).toEqual(['127.0.0.1/32', '::1/128']);
		expect(config.BODY_LIMIT_BYTES).toBe(65536);
		expect(() => validateEnvironment({ NODE_ENV: 'test', BODY_LIMIT_BYTES: '0' })).toThrow(
			'BODY_LIMIT_BYTES',
		);
	});

	it('rejects insecure production origins before loading secrets', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'production',
				API_PUBLIC_ORIGIN: 'https://api.akiba.com',
				CORS_ORIGINS: 'http://admin.akiba.com',
			}),
		).toThrow('HTTPS');
	});

	it('rejects origins containing paths', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'test',
				CORS_ORIGINS: 'https://kimihurura.akiba.com/dashboard',
			}),
		).toThrow('CORS_ORIGINS must contain HTTP origins without paths.');
	});

	it('disables production Swagger by default', () => {
		const configuration = validateEnvironment({
			NODE_ENV: 'production',
			API_PUBLIC_ORIGIN: 'https://api.akiba.com',
			CORS_ORIGINS: 'https://akiba.com,https://admin.akiba.com',
			DATABASE_URL:
				'postgresql://neondb_owner:fictional@production.example.com/neondb?sslmode=require',
			PLATFORM_ADMIN_ORIGIN: 'https://admin.akiba.com',
			PLATFORM_AUTH_DUMMY_PASSWORD_HASH:
				'$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			PLATFORM_AUTH_TOKEN_PEPPER: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
			PLATFORM_AUTH_SINGLE_INSTANCE: 'true',
			PLATFORM_TOTP_KEYRING: 'production-v1=AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
			PLATFORM_TOTP_ACTIVE_KEY_ID: 'production-v1',
			ORGANIZATION_PORTAL_BASE_DOMAIN: 'akiba.com',
			OWNER_AUTH_TOKEN_PEPPER: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
			OWNER_ENROLLMENT_TOKEN_PEPPER: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=',
		});

		expect(configuration.SWAGGER_ENABLED).toBe(false);
		expect(configuration.CORS_ORIGINS).toEqual(['https://akiba.com', 'https://admin.akiba.com']);
		expect(configuration.ORGANIZATION_PORTAL_ORIGIN).toBeNull();
		expect(configuration.ORGANIZATION_PORTAL_BASE_DOMAIN).toBe('akiba.com');
	});

	it('uses the existing managed owner connection for explicit development bootstrap', () => {
		const config = validateEnvironment({
			NODE_ENV: 'development',
			DATABASE_URL:
				'postgresql://neondb_owner:fictional@development.example.com/neondb?sslmode=require',
			PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true',
		});
		expect(config.PLATFORM_OWNER_BOOTSTRAP_ENABLED).toBe(true);
	});

	it('cannot enable live bootstrap in the offline test process', () => {
		expect(() =>
			validateEnvironment({ NODE_ENV: 'test', PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true' }),
		).toThrow('development or production');
	});

	it('does not retain an injected connection URL in offline configuration', () => {
		expect(
			validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'private-value' }).DATABASE_URL,
		).toBeNull();
	});

	it('requires encrypted development database connections', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'development',
				DATABASE_URL: 'postgresql://neondb_owner:fictional@development.example.com/neondb',
			}),
		).toThrow('TLS');
	});

	it('rejects the development key material in production', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'production',
				API_PUBLIC_ORIGIN: 'https://api.akiba.com',
				CORS_ORIGINS: 'https://admin.akiba.com',
				DATABASE_URL:
					'postgresql://neondb_owner:fictional@production.example.com/neondb?sslmode=require',
				PLATFORM_ADMIN_ORIGIN: 'https://admin.akiba.com',
				PLATFORM_AUTH_DUMMY_PASSWORD_HASH:
					'$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljLXNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				PLATFORM_AUTH_TOKEN_PEPPER: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
				PLATFORM_AUTH_SINGLE_INSTANCE: 'true',
				PLATFORM_TOTP_KEYRING: 'production-v1=AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
				ORGANIZATION_PORTAL_BASE_DOMAIN: 'akiba.com',
			}),
		).toThrow('PLATFORM_AUTH_TOKEN_PEPPER must not use the local development key.');
	});
});
