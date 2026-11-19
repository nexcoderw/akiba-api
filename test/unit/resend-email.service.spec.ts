import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { ResendEmailService } from '../../src/infrastructure/email/resend-email.service.js';

describe('ResendEmailService', () => {
	const fetchMock = jest.fn<typeof fetch>();
	const service = new ResendEmailService(
		new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({
				NODE_ENV: 'test',
				PLATFORM_AUTH_EMAIL_OTP_ENABLED: 'true',
				RESEND_API_KEY: 're_fictional',
				RESEND_FROM_EMAIL: 'security@example.com',
			}),
		),
	);
	beforeEach(() => {
		jest.clearAllMocks();
		jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
	});
	afterEach(() => {
		jest.restoreAllMocks();
	});
	it('uses the fixed HTTPS endpoint and an idempotency key', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ id: '2f5298af-cf42-4e66-8968-a42be74cb34b' }));
		await service.sendOtp('admin@example.com', '012345', 'fictional-delivery-id');
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			redirect: 'error',
			headers: { 'Idempotency-Key': 'platform-otp/fictional-delivery-id' },
		});
	});
	it('keeps the owner setup proof out of the URL and provider idempotency key', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ id: '2f5298af-cf42-4e66-8968-a42be74cb34b' }));
		const token = 'a'.repeat(43);
		await service.sendOwnerEnrollment('owner@example.com', token, 'reviewed-delivery');
		const options = fetchMock.mock.calls[0]?.[1];
		expect(options).toMatchObject({
			headers: { 'Idempotency-Key': 'platform-owner-enrollment/reviewed-delivery' },
		});
		const body: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
		expect(body).toMatchObject({ to: ['owner@example.com'] });
		if (
			typeof body !== 'object' ||
			body === null ||
			!('text' in body) ||
			typeof body.text !== 'string'
		)
			throw new Error('Missing enrollment email text.');
		expect(body.text).toContain(`setup code: ${token}`);
		expect(body.text).toContain('http://localhost:4000/enroll/platform-owner');
		expect(body.text).not.toContain(`?token=${token}`);
		expect(body.text).not.toContain(`#${token}`);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it('uses only approved security templates and never interpolates authenticator material', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ id: '2f5298af-cf42-4e66-8968-a42be74cb34b' }));
		await service.sendSecurityNotification(
			'owner@example.com',
			'mfa_factor_replaced',
			'notification-id',
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			headers: { 'Idempotency-Key': 'platform-security/notification-id' },
			body: JSON.stringify({
				from: 'security@example.com',
				to: ['owner@example.com'],
				subject: 'Akiba platform security change',
				text: 'Your authenticator was replaced and prior sessions were invalidated. If you did not authorize this change, contact your approved security operator immediately. This message contains no sign-in or recovery credentials.',
			}),
		});
		await expect(
			service.sendSecurityNotification('owner@example.com', 'unapproved-secret', 'notification-id'),
		).rejects.toMatchObject({ status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([401, 429, 500])('sanitizes provider failure %s and never retries', async (status) => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ message: 'private provider message' }, { status }),
		);
		await expect(
			service.sendOtp('admin@example.com', '012345', 'delivery-id'),
		).rejects.toMatchObject({ status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it.each([{}, { id: 'invalid' }])('rejects an incompatible success payload', async (body) => {
		fetchMock.mockResolvedValueOnce(Response.json(body));
		await expect(
			service.sendOtp('admin@example.com', '012345', 'delivery-id'),
		).rejects.toMatchObject({ status: 503 });
	});
	it('bounds provider response bytes', async () => {
		fetchMock.mockResolvedValueOnce(new Response('x'.repeat(4_097)));
		await expect(
			service.sendOtp('admin@example.com', '012345', 'delivery-id'),
		).rejects.toMatchObject({ status: 503 });
	});
});
