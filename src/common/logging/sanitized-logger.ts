import { ConsoleLogger, type LoggerService, type LogLevel } from '@nestjs/common';

import { isApiErrorCode } from '../errors/api-error-code.js';

const EVENTS = new Set([
	'request.completed',
	'request.failed',
	'request.aborted',
	'startup.failed',
	'shutdown.failed',
	'platform_login_rejected',
	'platform_mfa_challenge_created',
	'platform_mfa_rejected',
	'platform_session_created',
	'platform_session_rejected',
	'platform_session_revoked',
	'owner_login_rejected',
	'owner_session_created',
]);

function record(message: unknown): Record<string, unknown> | undefined {
	let candidate: unknown = message;
	if (typeof message === 'string' && message.length <= 8192) {
		try {
			candidate = JSON.parse(message);
		} catch {
			return undefined;
		}
	}
	return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
		? (candidate as Record<string, unknown>)
		: undefined;
}

/** Projects only reviewed diagnostic fields; framework errors and optional stacks are never printed. */
export function sanitizedLog(message: unknown, level: LogLevel): Readonly<Record<string, unknown>> {
	const input = record(message);
	const event =
		typeof input?.event === 'string' && EVENTS.has(input.event)
			? input.event
			: `application.${level}`;
	const output: Record<string, unknown> = { timestamp: new Date().toISOString(), event };
	if (input !== undefined && typeof input.event === 'string' && EVENTS.has(input.event)) {
		if (typeof input.requestId === 'string' && /^req_[0-9a-f-]{36}$/u.test(input.requestId))
			output.requestId = input.requestId;
		if (
			typeof input.method === 'string' &&
			/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|OTHER)$/u.test(input.method)
		)
			output.method = input.method;
		if (
			typeof input.route === 'string' &&
			input.route.length <= 256 &&
			/^[/A-Za-z0-9:._*{}()+?\\-]+$/u.test(input.route)
		)
			output.route = input.route;
		if (
			typeof input.status === 'number' &&
			Number.isInteger(input.status) &&
			input.status >= 100 &&
			input.status <= 599
		)
			output.status = input.status;
		if (
			typeof input.durationMilliseconds === 'number' &&
			Number.isFinite(input.durationMilliseconds) &&
			input.durationMilliseconds >= 0
		)
			output.durationMilliseconds = input.durationMilliseconds;
		if (isApiErrorCode(input.errorCode) || input.errorCode === null)
			output.errorCode = input.errorCode;
		for (const field of ['staffId', 'userId', 'challengeId'] as const) {
			const value = input[field];
			if (typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value)) output[field] = value;
		}
		const diagnostics = record(input.diagnostics);
		if (diagnostics !== undefined) {
			output.diagnostics = {
				databaseCode:
					typeof diagnostics.databaseCode === 'string' &&
					/^P[0-9]{4}$/u.test(diagnostics.databaseCode)
						? diagnostics.databaseCode
						: undefined,
				sqlState:
					typeof diagnostics.sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(diagnostics.sqlState)
						? diagnostics.sqlState
						: undefined,
				transactionFailure:
					typeof diagnostics.transactionFailure === 'string' &&
					['start_timeout', 'execution_timeout', 'already_closed', 'not_found', 'unknown'].includes(
						diagnostics.transactionFailure,
					)
						? diagnostics.transactionFailure
						: undefined,
			};
		}
	}
	return Object.freeze(output);
}

export class SanitizedLogger implements LoggerService {
	private readonly sink = new ConsoleLogger('Akiba', { json: true, colors: false });
	log(message: unknown): void {
		this.sink.log(sanitizedLog(message, 'log'));
	}
	error(message: unknown): void {
		this.sink.error(sanitizedLog(message, 'error'));
	}
	warn(message: unknown): void {
		this.sink.warn(sanitizedLog(message, 'warn'));
	}
	debug(message: unknown): void {
		this.sink.debug(sanitizedLog(message, 'debug'));
	}
	verbose(message: unknown): void {
		this.sink.verbose(sanitizedLog(message, 'verbose'));
	}
	fatal(message: unknown): void {
		this.sink.fatal(sanitizedLog(message, 'fatal'));
	}
}
