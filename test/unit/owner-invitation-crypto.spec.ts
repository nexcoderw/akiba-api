import { createHmac, randomBytes } from 'node:crypto';

import { parseOwnerInvitationDeliveryEnvironment } from '../../src/config/owner-invitation-delivery.environment.js';
import { validateOwnerInvitationWorkerEnvironment } from '../../src/config/owner-invitation-worker.environment.js';
import { OwnerInvitationTokenEnvelopeService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token-envelope.service.js';
import { OwnerInvitationTokenService } from '../../src/modules/platform/owner-onboarding/owner-invitation-token.service.js';
import {
	invitationDeliveryConfig,
	invitationDeliveryInput,
} from '../fixtures/owner-invitation-delivery.fixture.js';

const identity = {
	id: '11111111-1111-4111-8111-111111111111',
	organizationId: '22222222-2222-4222-8222-222222222222',
	ownerInvitationId: '33333333-3333-4333-8333-333333333333',
};
const fixedPortalPolicy = {
	fixedOrigin: 'https://owners.example.invalid',
	baseDomain: null,
};

describe('owner invitation configuration and cryptography', () => {
	it('validates a separately provisioned worker without HTTP session or TOTP secrets', () => {
		const input = {
			...invitationDeliveryInput(),
			DATABASE_URL:
				'postgresql://akiba_invitation_worker:fictional@localhost:5432/disposable_organization',
		};
		const worker = validateOwnerInvitationWorkerEnvironment(input);
		expect(worker.DATABASE_POOL_MAX).toBeLessThanOrEqual(16);
		expect(worker.RESEND_FROM_EMAIL).toBe('onboarding@resend.dev');
		expect(worker).not.toHaveProperty('PLATFORM_AUTH_TOKEN_PEPPER');
		expect(worker).not.toHaveProperty('PLATFORM_TOTP_KEYRING');
		expect(() =>
			validateOwnerInvitationWorkerEnvironment({
				...input,
				OWNER_INVITATION_DELIVERY_ENABLED: 'false',
			}),
		).toThrow('approved');
		expect(() =>
			validateOwnerInvitationWorkerEnvironment({
				...input,
				DATABASE_URL: 'postgresql://neondb_owner:fictional@localhost:5432/disposable_organization',
			}),
		).toThrow('restricted');
	});
	it('is off by default and requires database and independent destination approval', () => {
		expect(parseOwnerInvitationDeliveryEnvironment({}, false, fixedPortalPolicy)).toBeNull();
		const input = invitationDeliveryInput();
		expect(() =>
			parseOwnerInvitationDeliveryEnvironment(
				{ ...input, OWNER_INVITATION_DELIVERY_DATABASE_APPROVED: 'false' },
				false,
				fixedPortalPolicy,
			),
		).toThrow('independent approval');
		expect(() =>
			parseOwnerInvitationDeliveryEnvironment(
				{ ...input, OWNER_INVITATION_ACCEPTANCE_REVIEW_ID: '' },
				false,
				fixedPortalPolicy,
			),
		).toThrow('REVIEW_ID');
	});

	it.each([
		{ OWNER_INVITATION_ACCEPTANCE_PATH: '/accept?return=https://evil.invalid' },
		{ OWNER_INVITATION_TOKEN_HMAC_SECRET: Buffer.alloc(32).toString('base64') },
		{ OWNER_INVITATION_ENCRYPTION_ACTIVE_KEY_ID: 'missing' },
		{ OWNER_INVITATION_DELIVERY_CONCURRENCY: '5' },
		{ OWNER_INVITATION_DELIVERY_LEASE_SECONDS: '9999' },
		{ OWNER_INVITATION_DELIVERY_MAX_ATTEMPTS: '11' },
	])('rejects unsafe enabled configuration %j', (overrides) => {
		expect(() =>
			parseOwnerInvitationDeliveryEnvironment(
				{ ...invitationDeliveryInput(), ...overrides },
				false,
				fixedPortalPolicy,
			),
		).toThrow();
	});

	it('rejects reused invitation secrets', () => {
		const input = invitationDeliveryInput();
		expect(() =>
			parseOwnerInvitationDeliveryEnvironment(
				{
					...input,
					OWNER_INVITATION_ENCRYPTION_KEYRING: `key=${String(input.OWNER_INVITATION_TOKEN_HMAC_SECRET)}`,
				},
				false,
				fixedPortalPolicy,
			),
		).toThrow('separate');
	});

	it('generates canonical opaque tokens and purpose-separated keyed digests', () => {
		const config = invitationDeliveryConfig();
		const tokens = new OwnerInvitationTokenService(config);
		const values = Array.from({ length: 128 }, () => tokens.generate());
		expect(new Set(values).size).toBe(128);
		for (const token of values) {
			expect(Buffer.from(token, 'base64url')).toHaveLength(32);
			expect(tokens.isValidFormat(token)).toBe(true);
			const digest = tokens.digest(token);
			expect(tokens.matches(token, digest)).toBe(true);
			expect(tokens.matches(tokens.generate(), digest)).toBe(false);
			const settings = config.get('OWNER_INVITATION_DELIVERY', { infer: true });
			if (settings === null) throw new Error('Missing fixture configuration.');
			expect(digest).not.toBe(
				createHmac('sha256', Buffer.from(settings.hmacSecret, 'base64'))
					.update(JSON.stringify(['platform-session', token]))
					.digest('hex'),
			);
		}
		for (const value of ['', 'x'.repeat(44), '../secret', 'a'.repeat(43)]) {
			expect(tokens.isValidFormat(value)).toBe(false);
		}
	});

	it('authenticates ciphertext, identity, version, key and tag; supports old-key rotation', () => {
		const input = invitationDeliveryInput();
		const config = invitationDeliveryConfig(input);
		const envelopes = new OwnerInvitationTokenEnvelopeService(config);
		const snapshot = {
			token: new OwnerInvitationTokenService(config).generate(),
			organizationName: 'Kimihurura Supplies',
			recipient: 'owner@example.com',
			sender: 'onboarding@resend.dev',
			acceptanceOrigin: 'https://owners.example.invalid',
			acceptancePath: '/invitations/accept',
		};
		const envelope = envelopes.encrypt(identity, snapshot);
		const another = envelopes.encrypt(identity, snapshot);
		expect(envelope.tokenInitializationVector).not.toEqual(another.tokenInitializationVector);
		expect(envelope.tokenInitializationVector).toHaveLength(12);
		expect(envelope.tokenAuthenticationTag).toHaveLength(16);
		expect(Buffer.from(envelope.tokenCiphertext).toString('utf8')).not.toContain(snapshot.token);
		expect(envelopes.decrypt(identity, envelope)).toEqual(snapshot);
		for (const changed of [
			{ ...envelope, tokenAuthenticationTag: new Uint8Array(16) },
			{ ...envelope, tokenCiphertext: new Uint8Array(envelope.tokenCiphertext.length) },
			{ ...envelope, tokenEncryptionKeyId: 'missing' },
			{ ...envelope, tokenEncryptionVersion: 2 },
		])
			expect(() => envelopes.decrypt(identity, changed)).toThrow('could not be opened');
		for (const field of ['id', 'organizationId', 'ownerInvitationId']) {
			expect(() => envelopes.decrypt({ ...identity, [field]: 'different' }, envelope)).toThrow();
		}
		const originalKeyring = String(input.OWNER_INVITATION_ENCRYPTION_KEYRING);
		const nextKey = randomBytes(32).toString('base64');
		const rotated = new OwnerInvitationTokenEnvelopeService(
			invitationDeliveryConfig({
				...input,
				OWNER_INVITATION_ENCRYPTION_KEYRING: `${originalKeyring},next=${nextKey}`,
				OWNER_INVITATION_ENCRYPTION_ACTIVE_KEY_ID: 'next',
			}),
		);
		expect(rotated.decrypt(identity, envelope)).toEqual(snapshot);
		const replacementKey = randomBytes(32).toString('base64');
		const retired = new OwnerInvitationTokenEnvelopeService(
			invitationDeliveryConfig({
				...input,
				OWNER_INVITATION_ENCRYPTION_KEYRING: `replacement=${replacementKey}`,
				OWNER_INVITATION_ENCRYPTION_ACTIVE_KEY_ID: 'replacement',
			}),
		);
		expect(() => retired.decrypt(identity, envelope)).toThrow();
	});
});
