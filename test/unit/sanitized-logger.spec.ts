import { sanitizedLog } from '../../src/common/logging/sanitized-logger.js';

describe('production log projection', () => {
	it('discards arbitrary error messages, stacks, payloads and unrecognized structured records', () => {
		for (const input of [
			new Error('private-password'),
			'postgresql://user:private-password@internal-host/database',
			{ event: 'provider.error', route: 'private-password', cookie: 'private-cookie' },
		]) {
			const result = sanitizedLog(input, 'error');
			expect(Object.keys(result).sort()).toEqual(['event', 'timestamp']);
			expect(result.event).toBe('application.error');
			expect(typeof result.timestamp).toBe('string');
		}
	});

	it('retains reviewed correlation and diagnostic codes while dropping secret extensions', () => {
		const result = sanitizedLog(
			JSON.stringify({
				event: 'request.failed',
				requestId: 'req_724fbc40-515c-4a30-a4bb-8a6458a24396',
				method: 'POST',
				route: '/api/v1/organizations/:id',
				status: 503,
				errorCode: 'SERVICE_UNAVAILABLE',
				durationMilliseconds: 12,
				diagnostics: {
					databaseCode: 'P2028',
					sqlState: '08006',
					transactionFailure: 'start_timeout',
					message: 'private-password',
				},
				password: 'private-password',
				headers: { cookie: 'private-cookie' },
			}),
			'error',
		);
		expect(result).toMatchObject({
			event: 'request.failed',
			status: 503,
			errorCode: 'SERVICE_UNAVAILABLE',
			diagnostics: {
				databaseCode: 'P2028',
				sqlState: '08006',
				transactionFailure: 'start_timeout',
			},
		});
		expect(JSON.stringify(result)).not.toMatch(/private-password|private-cookie/u);
	});
});
