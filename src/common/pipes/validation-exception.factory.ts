import type { ValidationError } from '@nestjs/common';

import { ApiProblemException } from '../errors/api-problem.exception.js';
import {
	MAX_VALIDATION_ISSUES,
	validationIssue,
	type FieldErrorCode,
	type ValidationIssue,
} from '../errors/validation-issue.js';

const CONSTRAINT_CODES: Readonly<Record<string, FieldErrorCode>> = {
	isDefined: 'REQUIRED',
	isNotEmpty: 'REQUIRED',
	isString: 'INVALID_TYPE',
	isInt: 'INVALID_TYPE',
	isNumber: 'INVALID_TYPE',
	isBoolean: 'INVALID_TYPE',
	isArray: 'INVALID_TYPE',
	isEmail: 'INVALID_EMAIL',
	isUuid: 'INVALID_IDENTIFIER',
	isEnum: 'INVALID_CHOICE',
	isIn: 'INVALID_CHOICE',
	maxLength: 'TOO_LONG',
	minLength: 'TOO_SHORT',
	isLength: 'INVALID_LENGTH',
	arrayMaxSize: 'INVALID_ARRAY_SIZE',
	arrayMinSize: 'INVALID_ARRAY_SIZE',
	min: 'OUT_OF_RANGE',
	max: 'OUT_OF_RANGE',
	nestedValidation: 'INVALID_STRUCTURE',
	unknownValue: 'INVALID_OBJECT',
	matches: 'INVALID_FORMAT',
	isIso8601: 'INVALID_FORMAT',
	isDateString: 'INVALID_FORMAT',
	isDate: 'INVALID_FORMAT',
	isUrl: 'INVALID_FORMAT',
	whitelistValidation: 'UNEXPECTED_FIELD',
};

/** Bound recursion/output and use constraint identifiers, never custom messages, targets or values. */
export function createValidationException(errors: ValidationError[]): ApiProblemException {
	const issues: ValidationIssue[] = [];
	let visited = 0;
	const visit = (entries: ValidationError[], parent: string, depth: number): void => {
		if (depth >= 8) return;
		for (const entry of entries) {
			if (visited >= 100 || issues.length >= MAX_VALIDATION_ISSUES) return;
			visited += 1;
			const property = typeof entry.property === 'string' ? entry.property : '$';
			const field = parent === '' ? property : `${parent}.${property}`;
			for (const constraint of Object.keys(entry.constraints ?? {})) {
				if (issues.length >= MAX_VALIDATION_ISSUES) return;
				issues.push(validationIssue(field, CONSTRAINT_CODES[constraint] ?? 'INVALID_VALUE'));
			}
			visit(entry.children ?? [], field, depth + 1);
		}
	};
	visit(errors, '', 0);
	return new ApiProblemException('VALIDATION_FAILED', issues);
}
