import { validateEnvironment } from '../../src/config/environment.validation.js';

describe('validateEnvironment', () => {
	it('returns safe offline test defaults', () => {
		expect(validateEnvironment({ NODE_ENV: 'test' })).toEqual({
			NODE_ENV: 'test',
			HOST: '127.0.0.1',
			PORT: 3000,
			BODY_LIMIT_BYTES: 32768,
			TRUST_PROXY_CIDRS: [],
			CORS_ORIGINS: ['http://localhost:4000', 'http://localhost:4001'],
			SWAGGER_ENABLED: true,
			RATE_LIMIT_TTL_MS: 60_000,
			RATE_LIMIT_LIMIT: 100,
			DATABASE_URL: 'postgresql://offline:offline@127.0.0.1:1/akiba_offline',
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
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_HOST: null,
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME: null,
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE: null,
			PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER: null,
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
			validateEnvironment({ NODE_ENV: 'production', CORS_ORIGINS: 'http://admin.akiba.com' }),
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
			CORS_ORIGINS: 'https://akiba.com,https://admin.akiba.com',
			DATABASE_URL: 'postgresql://akiba_app:password@database.example/akiba?sslmode=require',
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

	it('requires an exact database fingerprint when owner bootstrap is enabled', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'test',
				DATABASE_URL: 'postgresql://akiba_bootstrap:secret@approved.neon.tech/neondb',
				PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_HOST: 'wrong.neon.tech',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME: 'neondb',
			}),
		).toThrow(
			'The configured database does not match the approved platform owner bootstrap target.',
		);
	});

	it('rejects the development key material in production', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'production',
				CORS_ORIGINS: 'https://admin.akiba.com',
				DATABASE_URL: 'postgresql://akiba_app:password@database.example/akiba?sslmode=require',
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

	it.each([
		{ role: 'neondb_owner', marker: 'akiba:bootstrap:724fbc40-515c-4a30-a4bb-8a6458a24396' },
		{ role: 'akiba_app', marker: 'akiba:bootstrap:724fbc40-515c-4a30-a4bb-8a6458a24396' },
		{ role: 'akiba_bootstrap', marker: 'unprovisioned' },
	])('rejects inappropriate bootstrap role or marker %j', ({ role, marker }) => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'test',
				DATABASE_URL: `postgresql://${role}:fictional@approved.neon.tech/neondb`,
				PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_HOST: 'approved.neon.tech',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME: 'neondb',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE: role,
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER: marker,
			}),
		).toThrow();
	});

	it('requires the configured URL user to match the approved operator role', () => {
		expect(() =>
			validateEnvironment({
				NODE_ENV: 'test',
				DATABASE_URL: 'postgresql://akiba_app:fictional@approved.neon.tech/neondb',
				PLATFORM_OWNER_BOOTSTRAP_ENABLED: 'true',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_HOST: 'approved.neon.tech',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME: 'neondb',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE: 'akiba_bootstrap',
				PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER:
					'akiba:bootstrap:724fbc40-515c-4a30-a4bb-8a6458a24396',
			}),
		).toThrow('The configured bootstrap database role does not match the approved role.');
	});
});
