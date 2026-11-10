import { HttpException } from '@nestjs/common';

import { PROBLEM_CATALOG, type ApiErrorCode } from './api-error-code.js';
import {
	MAX_VALIDATION_ISSUES,
	validationIssue,
	type ValidationIssue,
} from './validation-issue.js';

/** Explicit safe application errors; causes stay internal and public text comes only from the catalog. */
export class ApiProblemException extends HttpException {
	readonly publicCode: ApiErrorCode;
	readonly fieldErrors: readonly ValidationIssue[];

	constructor(code: ApiErrorCode, errors: readonly ValidationIssue[] = [], cause?: unknown) {
		super({ code }, PROBLEM_CATALOG[code].status, { cause });
		this.publicCode = code;
		this.fieldErrors = errors
			.slice(0, MAX_VALIDATION_ISSUES)
			.map(({ field, code: fieldCode }) => validationIssue(field, fieldCode));
	}
}
