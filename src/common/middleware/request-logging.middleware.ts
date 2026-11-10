import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import { requestObservation } from '../logging/request-observation.js';
import type { RequestWithContext } from '../types/request-with-context.js';

/** Runs before parsers and guards so every completed HTTP response has one sanitized access record. */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware<RequestWithContext, Response> {
	private readonly logger = new Logger(RequestLoggingMiddleware.name);

	use(request: RequestWithContext, response: Response, next: NextFunction): void {
		const record = (event: 'request.completed' | 'request.aborted'): void => {
			response.off('finish', onFinish);
			response.off('close', onClose);
			this.logger.log(
				JSON.stringify({
					event,
					...requestObservation(request),
					status: event === 'request.aborted' ? 499 : response.statusCode,
					errorCode: request.problemCode ?? null,
				}),
			);
		};
		const onFinish = (): void => record('request.completed');
		const onClose = (): void => record('request.aborted');
		response.once('finish', onFinish);
		response.once('close', onClose);
		next();
	}
}
