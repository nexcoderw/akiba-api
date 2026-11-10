import { jest } from '@jest/globals';
import { BadRequestException, HttpException, Logger, type ArgumentsHost } from '@nestjs/common';

import { PROBLEM_CATALOG } from '../../src/common/errors/api-error-code.js';
import { ApiExceptionFilter } from '../../src/common/filters/api-exception.filter.js';

function capture(exception: unknown) {
	const request = {
		method: 'POST',
		requestId: '',
		path: '/secret-value',
		route: { path: '/probe/:id' },
	};
	const response = {
		headersSent: false,
		status: jest.fn(),
		setHeader: jest.fn(),
		type: jest.fn(),
		json: jest.fn(),
	};
	response.status.mockReturnValue(response);
	response.type.mockReturnValue(response);
	const host = {
		switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
	} as unknown as ArgumentsHost;
	new ApiExceptionFilter().catch(exception, host);
	return response;
}

describe('global Problem Details filter', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		[400, 'BAD_REQUEST'],
		[401, 'UNAUTHENTICATED'],
		[403, 'ACCESS_DENIED'],
		[404, 'RESOURCE_NOT_FOUND'],
		[405, 'METHOD_NOT_ALLOWED'],
		[409, 'RESOURCE_CONFLICT'],
		[413, 'PAYLOAD_TOO_LARGE'],
		[415, 'UNSUPPORTED_MEDIA_TYPE'],
		[429, 'RATE_LIMITED'],
		[503, 'SERVICE_UNAVAILABLE'],
	])('preserves status %s with an approved public code', (status, code) => {
		if (typeof status !== 'number') throw new Error('Invalid test status.');
		jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		const response = capture(new HttpException('SQL private-password /private/host', status));
		expect(response.status).toHaveBeenCalledWith(status);
		expect(response.type).toHaveBeenCalledWith('application/problem+json');
		expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ status, code }));
		const body: unknown = response.json.mock.calls[0]?.[0];
		if (typeof body !== 'object' || body === null || !('requestId' in body)) {
			throw new Error('Expected a correlated problem response.');
		}
		expect(body.requestId).toEqual(expect.stringMatching(/^req_[0-9a-f-]{36}$/u));
		expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
			/SQL|private-password|private\/host|secret-value/u,
		);
	});

	it('discards unapproved HTTP bodies, details and code values', () => {
		const response = capture(
			new BadRequestException({
				code: 'SQL_PRIVATE_TABLE',
				message: 'password-secret',
				details: [{ value: 'reset-token-secret' }],
			}),
		);
		expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BAD_REQUEST' }));
		expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
			/SQL_PRIVATE_TABLE|password-secret|reset-token-secret/u,
		);
	});

	it.each([
		{ code: 'P2002', status: 409 },
		{ code: 'P1001', status: 503 },
		{ code: 'P2025', status: 500 },
	])('sanitizes database error $code', ({ code, status }) => {
		const logs = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		const response = capture(
			Object.assign(new Error('postgresql://user:password-secret@internal-host/private-table'), {
				code,
			}),
		);
		expect(response.status).toHaveBeenCalledWith(status);
		expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
			/P\d{4}|password-secret|internal-host|private-table/u,
		);
		expect(JSON.stringify(logs.mock.calls)).not.toMatch(
			/password-secret|internal-host|private-table/u,
		);
	});

	it('keeps unknown failures generic and the catalog stable', () => {
		const logs = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		const response = capture(new Error('raw-secret-stack-message'));
		expect(response.status).toHaveBeenCalledWith(500);
		expect(response.json).toHaveBeenCalledWith(
			expect.objectContaining({
				code: 'INTERNAL_ERROR',
				detail: PROBLEM_CATALOG.INTERNAL_ERROR.detail,
			}),
		);
		expect(JSON.stringify(logs.mock.calls)).not.toContain('raw-secret-stack-message');
		expect(PROBLEM_CATALOG.AUTH_RECOVERY_INVALID.detail).toBe(
			PROBLEM_CATALOG.AUTH_RECOVERY_EXPIRED.detail,
		);
	});

	it.each(['development', 'production'])('redacts unexpected exceptions in %s', (environment) => {
		const previous = process.env.NODE_ENV;
		process.env.NODE_ENV = environment;
		const logs = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		try {
			const response = capture(new Error('secret-provider-message /private/server/file.ts'));
			expect(response.status).toHaveBeenCalledWith(500);
			expect(JSON.stringify([response.json.mock.calls, logs.mock.calls])).not.toMatch(
				/secret-provider-message|private\/server/u,
			);
		} finally {
			if (previous === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previous;
		}
	});
});
