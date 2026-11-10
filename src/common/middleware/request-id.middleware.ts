import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import { REQUEST_ID_HEADER } from '../constants/api.constants.js';
import { ensureRequestId } from '../logging/request-observation.js';
import type { RequestWithContext } from '../types/request-with-context.js';

/** Always replace client correlation headers; callers cannot forge server request identities. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware<RequestWithContext, Response> {
	use(request: RequestWithContext, response: Response, next: NextFunction): void {
		request.requestId = '';
		request.startedAt = performance.now();
		response.setHeader(REQUEST_ID_HEADER, ensureRequestId(request));
		next();
	}
}
