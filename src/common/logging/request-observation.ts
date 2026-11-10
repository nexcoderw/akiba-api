import { randomUUID } from 'node:crypto';

import type { RequestWithContext } from '../types/request-with-context.js';

/** Parser errors and unmatched routes must receive a server-owned ID even without route middleware. */
export function ensureRequestId(request: RequestWithContext): string {
	if (typeof request.requestId !== 'string' || !/^req_[0-9a-f-]{36}$/u.test(request.requestId)) {
		request.requestId = `req_${randomUUID()}`;
	}
	return request.requestId;
}

/** Log only framework route templates; raw paths, query strings and parameter values are private. */
export function safeRoute(request: RequestWithContext): string {
	const route: unknown = request.route;
	if (
		typeof route === 'object' &&
		route !== null &&
		'path' in route &&
		typeof route.path === 'string' &&
		route.path.length <= 256 &&
		/^[/A-Za-z0-9:._*{}()+?\\-]+$/u.test(route.path)
	)
		return route.path;
	return 'unmatched';
}

export function requestObservation(request: RequestWithContext): {
	readonly timestamp: string;
	readonly requestId: string;
	readonly method: string;
	readonly route: string;
	readonly durationMilliseconds: number;
} {
	return {
		timestamp: new Date().toISOString(),
		requestId: ensureRequestId(request),
		method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)
			? request.method
			: 'OTHER',
		route: safeRoute(request),
		durationMilliseconds: Math.max(
			0,
			Math.round(performance.now() - (request.startedAt ?? performance.now())),
		),
	};
}
