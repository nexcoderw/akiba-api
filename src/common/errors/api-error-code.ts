/** Public Problem Details metadata. Messages are authored, never copied from exceptions. */
export interface ProblemDefinition {
	readonly status: number;
	readonly title: string;
	readonly detail: string;
}

const core = {
	VALIDATION_FAILED: {
		status: 400,
		title: 'Please check your information',
		detail: 'Some fields need to be corrected.',
	},
	BAD_REQUEST: {
		status: 400,
		title: 'Invalid request',
		detail: 'The request could not be processed.',
	},
	UNAUTHENTICATED: {
		status: 401,
		title: 'Authentication required',
		detail: 'Sign in to continue.',
	},
	ACCESS_DENIED: {
		status: 403,
		title: 'Access denied',
		detail: 'You do not have access to this operation.',
	},
	RESOURCE_NOT_FOUND: {
		status: 404,
		title: 'Resource unavailable',
		detail: 'The requested resource is unavailable.',
	},
	METHOD_NOT_ALLOWED: {
		status: 405,
		title: 'Method not allowed',
		detail: 'This HTTP method is not supported for this resource.',
	},
	REQUEST_TIMEOUT: {
		status: 408,
		title: 'Request timed out',
		detail: 'The request timed out. Please try again.',
	},
	RESOURCE_CONFLICT: {
		status: 409,
		title: 'Request conflict',
		detail: 'The operation could not be completed in the current state.',
	},
	PRECONDITION_FAILED: {
		status: 412,
		title: 'Information changed',
		detail: 'Refresh the information before trying again.',
	},
	PAYLOAD_TOO_LARGE: {
		status: 413,
		title: 'Request too large',
		detail: 'The request exceeds the permitted size.',
	},
	UNSUPPORTED_MEDIA_TYPE: {
		status: 415,
		title: 'Unsupported request format',
		detail: 'Send a supported request content type and encoding.',
	},
	UNPROCESSABLE_ENTITY: {
		status: 422,
		title: 'Invalid information',
		detail: 'The supplied information could not be processed.',
	},
	PRECONDITION_REQUIRED: {
		status: 428,
		title: 'Request precondition required',
		detail: 'Refresh the information before trying again.',
	},
	RATE_LIMITED: {
		status: 429,
		title: 'Please wait',
		detail: 'Too many requests. Wait before trying again.',
	},
	INTERNAL_ERROR: {
		status: 500,
		title: 'Something went wrong',
		detail: 'An unexpected error occurred. Please try again later.',
	},
	NOT_IMPLEMENTED: {
		status: 501,
		title: 'Operation unavailable',
		detail: 'This operation is not available.',
	},
	BAD_GATEWAY: {
		status: 502,
		title: 'Service temporarily unavailable',
		detail: 'A required service is temporarily unavailable. Please try again later.',
	},
	SERVICE_UNAVAILABLE: {
		status: 503,
		title: 'Service temporarily unavailable',
		detail: 'Please try again later.',
	},
	GATEWAY_TIMEOUT: {
		status: 504,
		title: 'Service timed out',
		detail: 'A required service did not respond in time. Please try again later.',
	},
	AUTH_INVALID_CREDENTIALS: {
		status: 401,
		title: 'Sign-in unsuccessful',
		detail: 'The supplied authentication credentials could not be accepted.',
	},
	AUTH_SESSION_EXPIRED: {
		status: 401,
		title: 'Sign-in required',
		detail: 'Your session is unavailable. Sign in again.',
	},
	AUTH_MFA_REQUIRED: {
		status: 412,
		title: 'Additional verification required',
		detail: 'Complete the required security verification.',
	},
	AUTH_MFA_INVALID: {
		status: 401,
		title: 'Verification unsuccessful',
		detail: 'The verification request could not be accepted.',
	},
	AUTH_RECOVERY_INVALID: {
		status: 401,
		title: 'Recovery unavailable',
		detail: 'The recovery request is invalid or unavailable.',
	},
	AUTH_RECOVERY_EXPIRED: {
		status: 401,
		title: 'Recovery unavailable',
		detail: 'The recovery request is invalid or unavailable.',
	},
	ORGANIZATION_UNAVAILABLE: {
		status: 404,
		title: 'Organization unavailable',
		detail: 'Organization access is unavailable.',
	},
	ORGANIZATION_ACCESS_DENIED: {
		status: 403,
		title: 'Access denied',
		detail: 'You do not have access to this operation.',
	},
} as const satisfies Readonly<Record<string, ProblemDefinition>>;

/** Existing reviewed domain codes retain their identifiers with catalog-controlled public text. */
export const PROBLEM_CATALOG = Object.freeze({
	...core,
	ORGANIZATION_CURSOR_INVALID: core.BAD_REQUEST,
	ORGANIZATION_PAGE_INVALID: core.BAD_REQUEST,
	ORGANIZATION_INTEGRITY_REJECTED: core.BAD_REQUEST,
	ORGANIZATION_PRECONDITION_REQUIRED: core.BAD_REQUEST,
	OWNER_INVITATION_CURSOR_INVALID: core.BAD_REQUEST,
	OWNER_INVITATION_PAGE_INVALID: core.BAD_REQUEST,
	OWNER_INVITATION_INTEGRITY_REJECTED: core.BAD_REQUEST,
	ORGANIZATION_NOT_FOUND: core.RESOURCE_NOT_FOUND,
	OWNER_ORGANIZATION_NOT_FOUND: core.RESOURCE_NOT_FOUND,
	OWNER_ORGANIZATION_UNAVAILABLE: core.RESOURCE_NOT_FOUND,
	OWNER_INVITATION_NOT_FOUND: core.RESOURCE_NOT_FOUND,
	ORGANIZATION_SLUG_CONFLICT: core.RESOURCE_CONFLICT,
	ORGANIZATION_TRANSITION_CONFLICT: core.RESOURCE_CONFLICT,
	OWNER_ENROLLMENT_CONFLICT: core.RESOURCE_CONFLICT,
	OWNER_INVITATION_CONCURRENT_CHANGE: core.RESOURCE_CONFLICT,
	OWNER_INVITATION_DELIVERY_CONFLICT: core.RESOURCE_CONFLICT,
	OWNER_INVITATION_DELIVERY_UNCERTAIN: core.RESOURCE_CONFLICT,
	OWNER_INVITATION_ORGANIZATION_UNAVAILABLE: core.RESOURCE_CONFLICT,
	OWNER_INVITATION_OUTSTANDING_CONFLICT: core.RESOURCE_CONFLICT,
	OWNER_INVITATION_TRANSITION_CONFLICT: core.RESOURCE_CONFLICT,
	ORGANIZATION_STALE: core.PRECONDITION_FAILED,
	PLATFORM_AUTHENTICATION_FAILED: core.AUTH_INVALID_CREDENTIALS,
	OWNER_AUTHENTICATION_FAILED: core.AUTH_INVALID_CREDENTIALS,
	PLATFORM_SESSION_INVALID: core.AUTH_SESSION_EXPIRED,
	OWNER_SESSION_INVALID: core.AUTH_SESSION_EXPIRED,
	PLATFORM_MFA_VERIFICATION_FAILED: core.AUTH_MFA_INVALID,
	OWNER_INVITATION_INVALID: core.AUTH_MFA_INVALID,
	OWNER_ENROLLMENT_INVALID: core.AUTH_MFA_INVALID,
	PLATFORM_MFA_SETUP_REQUIRED: core.AUTH_MFA_REQUIRED,
	PLATFORM_ORIGIN_REJECTED: core.ACCESS_DENIED,
	PLATFORM_CSRF_REJECTED: core.ACCESS_DENIED,
	PLATFORM_PERMISSION_DENIED: core.ACCESS_DENIED,
	PLATFORM_PERMISSION_REQUIRED: core.ACCESS_DENIED,
	OWNER_ORIGIN_REJECTED: core.ACCESS_DENIED,
	OWNER_CSRF_REJECTED: core.ACCESS_DENIED,
	PLATFORM_LOGIN_RATE_LIMITED: core.RATE_LIMITED,
	PLATFORM_EMAIL_RATE_LIMITED: core.RATE_LIMITED,
	OWNER_LOGIN_RATE_LIMITED: core.RATE_LIMITED,
	ORGANIZATION_AUDIT_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	ORGANIZATION_PERSISTENCE_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	OWNER_INVITATION_AUDIT_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	OWNER_INVITATION_DELIVERY_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	OWNER_INVITATION_PERSISTENCE_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	OWNER_ENROLLMENT_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	PLATFORM_SESSION_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	PLATFORM_LOGIN_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	PLATFORM_MFA_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	PLATFORM_EMAIL_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	OWNER_SESSION_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
	OWNER_LOGIN_UNAVAILABLE: core.SERVICE_UNAVAILABLE,
});

export type ApiErrorCode = keyof typeof PROBLEM_CATALOG;

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
	return typeof value === 'string' && Object.hasOwn(PROBLEM_CATALOG, value);
}

/** Reserved contracts do not indicate implemented recovery or MFA-enrollment workflows. */
export const RESERVED_AUTH_ERROR_CODES = Object.freeze([
	'AUTH_INVALID_CREDENTIALS',
	'AUTH_SESSION_EXPIRED',
	'AUTH_MFA_REQUIRED',
	'AUTH_MFA_INVALID',
	'AUTH_RECOVERY_INVALID',
	'AUTH_RECOVERY_EXPIRED',
] as const);

export function defaultErrorCode(status: number): ApiErrorCode {
	const codes: Readonly<Record<number, ApiErrorCode>> = {
		400: 'BAD_REQUEST',
		401: 'UNAUTHENTICATED',
		403: 'ACCESS_DENIED',
		404: 'RESOURCE_NOT_FOUND',
		405: 'METHOD_NOT_ALLOWED',
		408: 'REQUEST_TIMEOUT',
		409: 'RESOURCE_CONFLICT',
		412: 'PRECONDITION_FAILED',
		413: 'PAYLOAD_TOO_LARGE',
		415: 'UNSUPPORTED_MEDIA_TYPE',
		422: 'UNPROCESSABLE_ENTITY',
		428: 'PRECONDITION_REQUIRED',
		429: 'RATE_LIMITED',
		500: 'INTERNAL_ERROR',
		501: 'NOT_IMPLEMENTED',
		502: 'BAD_GATEWAY',
		503: 'SERVICE_UNAVAILABLE',
		504: 'GATEWAY_TIMEOUT',
	};
	return codes[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}
