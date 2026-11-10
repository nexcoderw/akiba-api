export const FIELD_ERROR_MESSAGES = Object.freeze({
	REQUIRED: 'This field is required.',
	INVALID_EMAIL: 'Enter a valid email address.',
	INVALID_IDENTIFIER: 'Enter a valid identifier.',
	INVALID_TYPE: 'Use the expected type of value.',
	INVALID_CHOICE: 'Choose an allowed value.',
	TOO_LONG: 'Use a shorter value.',
	TOO_SHORT: 'Use a longer value.',
	INVALID_LENGTH: 'Use a value of the permitted length.',
	INVALID_ARRAY_SIZE: 'Use the permitted number of items.',
	OUT_OF_RANGE: 'Use a value within the permitted range.',
	INVALID_STRUCTURE: 'Use the expected nested structure.',
	INVALID_OBJECT: 'Send a valid request object.',
	INVALID_FORMAT: 'Use the expected format.',
	UNEXPECTED_FIELD: 'Remove unexpected fields.',
	INVALID_VALUE: 'Enter a valid value.',
});

export type FieldErrorCode = keyof typeof FIELD_ERROR_MESSAGES;
export interface ValidationIssue {
	readonly field: string;
	readonly code: FieldErrorCode;
	readonly message: string;
}

export const MAX_VALIDATION_ISSUES = 20;

/** Never preserve attacker-selected field names from whitelist violations or malformed paths. */
export function validationIssue(field: string, code: FieldErrorCode): ValidationIssue {
	const safeField =
		code !== 'UNEXPECTED_FIELD' &&
		field.length <= 128 &&
		/^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,6})(?:\.(?:[A-Za-z_][A-Za-z0-9_]{0,63}|[0-9]{1,6})){0,7}$/u.test(
			field,
		) &&
		!field.split('.').some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
			? field
			: '$';
	return Object.freeze({ field: safeField, code, message: FIELD_ERROR_MESSAGES[code] });
}
