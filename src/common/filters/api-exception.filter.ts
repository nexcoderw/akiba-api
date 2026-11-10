import {
	type ArgumentsHost,
	Catch,
	HttpException,
	Logger,
	type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

import { REQUEST_ID_HEADER } from '../constants/api.constants.js';
import {
	PROBLEM_CATALOG,
	defaultErrorCode,
	isApiErrorCode,
	type ApiErrorCode,
} from '../errors/api-error-code.js';
import { ApiProblemException } from '../errors/api-problem.exception.js';
import {
	databaseErrorCode,
	databaseSqlState,
	databaseTransactionFailure,
} from '../errors/database-error-code.js';
import { requestObservation } from '../logging/request-observation.js';
import type { RequestWithContext } from '../types/request-with-context.js';
import type { ApiErrorResponseDto } from '../dto/api-error-response.dto.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Status selection never requires a database query and never returns a provider's public text. */
function exceptionStatus(exception: unknown): number {
	if (exception instanceof HttpException) {
		const status = exception.getStatus();
		return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
	}
	if (isRecord(exception)) {
		if (
			typeof exception.type === 'string' &&
			['entity.parse.failed', 'request.size.invalid', 'request.aborted'].includes(exception.type) &&
			exception.status === 400
		)
			return 400;
		if (
			typeof exception.type === 'string' &&
			['entity.too.large', 'parameters.too.many'].includes(exception.type) &&
			exception.status === 413
		)
			return 413;
		if (
			typeof exception.type === 'string' &&
			['charset.unsupported', 'encoding.unsupported'].includes(exception.type) &&
			exception.status === 415
		)
			return 415;
	}
	const code = databaseErrorCode(exception);
	if (
		code !== undefined &&
		['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034', 'P2037'].includes(code)
	)
		return 503;
	if (code === 'P2002' || code === 'P2003') return 409;
	if (code === 'P2000' || code === 'P2004') return 400;
	// A missing row is not globally translated: account/resource disclosure needs domain context.
	return 500;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
	private readonly logger = new Logger(ApiExceptionFilter.name);

	catch(exception: unknown, host: ArgumentsHost): void {
		const http = host.switchToHttp();
		const request = http.getRequest<RequestWithContext>();
		const response = http.getResponse<Response>();
		if (response.headersSent) return;
		const status = exceptionStatus(exception);
		const exceptionBody = exception instanceof HttpException ? exception.getResponse() : undefined;
		const proposed = isRecord(exceptionBody) ? exceptionBody.code : undefined;
		const code: ApiErrorCode =
			isApiErrorCode(proposed) && PROBLEM_CATALOG[proposed].status === status
				? proposed
				: defaultErrorCode(status);
		const definition = PROBLEM_CATALOG[code];
		const observation = requestObservation(request);
		request.problemCode = code;
		const problem: ApiErrorResponseDto = {
			type: `urn:akiba:problem:${code.toLowerCase().replaceAll('_', '-')}`,
			title: definition.title,
			status,
			detail: definition.detail,
			code,
			requestId: observation.requestId,
			...(exception instanceof ApiProblemException && exception.fieldErrors.length > 0
				? { errors: [...exception.fieldErrors] }
				: {}),
		};
		if (status >= 500) {
			const cause = exception instanceof HttpException ? exception.cause : exception;
			this.logger.error(
				JSON.stringify({
					event: 'request.failed',
					...observation,
					status,
					errorCode: code,
					diagnostics: {
						databaseCode: databaseErrorCode(cause),
						sqlState: databaseSqlState(cause),
						transactionFailure: databaseTransactionFailure(cause),
					},
				}),
			);
		}
		response.setHeader(REQUEST_ID_HEADER, observation.requestId);
		response.setHeader('Cache-Control', 'no-store');
		response.status(status).type('application/problem+json').json(problem);
	}
}
