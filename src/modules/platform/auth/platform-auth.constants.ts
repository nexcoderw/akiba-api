export const PLATFORM_SESSION_COOKIE = '__Host-akiba-platform-session';
export const LOCAL_PLATFORM_SESSION_COOKIE = 'akiba-platform-session';
export const PLATFORM_CSRF_COOKIE = '__Host-akiba-platform-csrf';
export const LOCAL_PLATFORM_CSRF_COOKIE = 'akiba-platform-csrf';
export const PLATFORM_CHALLENGE_COOKIE = '__Host-akiba-platform-challenge';
export const LOCAL_PLATFORM_CHALLENGE_COOKIE = 'akiba-platform-challenge';
export const PLATFORM_CSRF_HEADER = 'x-platform-csrf-token';
export const PLATFORM_PERMISSIONS_METADATA = 'platform-auth:permissions';

export const PLATFORM_AUTH_ERROR = Object.freeze({
	invalidCredentials: {
		code: 'PLATFORM_AUTHENTICATION_FAILED',
		message: 'The supplied authentication credentials are invalid',
	},
	invalidChallenge: {
		code: 'PLATFORM_MFA_VERIFICATION_FAILED',
		message: 'The MFA challenge or verification code is invalid',
	},
	invalidSession: {
		code: 'PLATFORM_SESSION_INVALID',
		message: 'The platform session is invalid or expired',
	},
} as const);
