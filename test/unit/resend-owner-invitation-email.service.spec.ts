import { jest } from '@jest/globals';

import { ResendOwnerInvitationEmailService } from '../../src/infrastructure/email/resend-owner-invitation-email.service.js';
import { OwnerInvitationTokenService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token.service.js';
import { invitationDeliveryConfig } from '../fixtures/owner-invitation-delivery.fixture.js';

describe('Resend owner invitation adapter (fake transport only)', () => {
	const originalFetch = globalThis.fetch;
	const fetchFake = jest.fn<typeof fetch>();
	const config = invitationDeliveryConfig();
	const adapter = new ResendOwnerInvitationEmailService(config);
	const snapshot = {
		token: new OwnerInvitationTokenService(config).generate(),
		organizationName: '<Kimihurura Supplies & organization>',
		recipient: 'owner@example.com',
		sender: 'onboarding@resend.dev',
		acceptanceOrigin: 'https://owners.example.invalid',
		acceptancePath: '/invitations/accept',
	};
	const key = 'owner-invitation-delivery:11111111-1111-4111-8111-111111111111';
	const messageId = '22222222-2222-4222-8222-222222222222';
	const expiry = new Date('2026-10-17T12:00:00Z');
	beforeEach(() => {
		globalThis.fetch = fetchFake;
		fetchFake.mockReset();
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	it('freezes payload, escapes markup, uses a fragment and preserves idempotency', async () => {
		fetchFake.mockImplementation(() => Promise.resolve(Response.json({ id: messageId })));
		await expect(adapter.send(snapshot, key, expiry)).resolves.toEqual({
			kind: 'accepted',
			messageId,
		});
		await adapter.send(snapshot, key, expiry);
		expect(fetchFake.mock.calls[0]?.[1]?.body).toEqual(fetchFake.mock.calls[1]?.[1]?.body);
		expect(fetchFake.mock.calls[0]?.[1]?.headers).toEqual(fetchFake.mock.calls[1]?.[1]?.headers);
		const call = fetchFake.mock.calls[0];
		expect(call?.[0]).toBe('https://api.resend.com/emails');
		expect(call?.[1]).toMatchObject({ redirect: 'error', headers: { 'Idempotency-Key': key } });
		const body = call?.[1]?.body;
		if (typeof body !== 'string') throw new Error('Missing provider request.');
		const payload: unknown = JSON.parse(body);
		expect(payload).toMatchObject({ from: 'onboarding@resend.dev' });
		expect(body).toContain('#token=');
		expect(body).toContain('&lt;Kimihurura Supplies &amp; organization&gt;');
		expect(body).not.toContain('?token=');
		expect(body).not.toContain('password is ');
	});

	it.each([400, 401, 403, 422, 429, 409, 500, 503])(
		'classifies HTTP %s without provider body disclosure or internal retry',
		async (status) => {
			fetchFake.mockResolvedValue(new Response('private provider response', { status }));
			const outcome = await adapter.send(snapshot, key, expiry);
			if (status === 429)
				expect(outcome).toEqual({ kind: 'failed', code: 'PROVIDER_RATE_LIMITED', retryable: true });
			else if ([409, 500, 503].includes(status)) expect(outcome.kind).toBe('uncertain');
			else expect(outcome).toEqual({ kind: 'failed', code: 'PROVIDER_REJECTED', retryable: false });
			expect(fetchFake).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(outcome)).not.toContain('private provider');
		},
	);

	it('treats timeouts and malformed or oversized successes as uncertain', async () => {
		fetchFake.mockRejectedValueOnce(new Error('private timeout details'));
		await expect(adapter.send(snapshot, key, expiry)).resolves.toMatchObject({ kind: 'uncertain' });
		for (const value of [{ id: 'invalid' }, { id: messageId, large: 'x'.repeat(5000) }]) {
			fetchFake.mockResolvedValueOnce(Response.json(value));
			await expect(adapter.send(snapshot, key, expiry)).resolves.toMatchObject({
				kind: 'uncertain',
			});
		}
	});

	it('fails before transport if the approved sender or destination changed', async () => {
		await expect(
			adapter.send({ ...snapshot, acceptanceOrigin: 'https://attacker.invalid' }, key, expiry),
		).resolves.toMatchObject({ kind: 'failed', retryable: false });
		await expect(
			adapter.send({ ...snapshot, sender: 'attacker@example.com' }, key, expiry),
		).resolves.toMatchObject({ kind: 'failed' });
		expect(fetchFake).not.toHaveBeenCalled();
	});
});
