import type { Request } from 'express';
import type { ApiErrorCode } from '../errors/api-error-code.js';

/** Express request enriched only with server-established request context. */
export interface RequestWithContext extends Request {
	requestId: string;
	startedAt?: number;
	problemCode?: ApiErrorCode;
}
