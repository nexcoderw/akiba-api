import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { normalizeEmailIdentity } from '../../src/common/identity/email-identity.js';
import { PlatformLoginDto } from '../../src/modules/platform/auth/dto/platform-login.dto.js';
import { OwnerLoginDto } from '../../src/modules/owner/auth/dto/owner-login.dto.js';
import { CreateOwnerInvitationDto } from '../../src/modules/platform/owner-onboarding/dto/create-owner-invitation.dto.js';

describe('global email identities', () => {
	it.each([
		[' ALICE+Stock@EXAMPLE.COM ', 'alice+stock@example.com'],
		['\u0085Alice@Example.com\u0085', 'alice@example.com'],
		['Alice@bücher.example', 'alice@xn--bcher-kva.example'],
		['Alice@bu\u0308cher.example', 'alice@xn--bcher-kva.example'],
		['a.b+stock@example.com', 'a.b+stock@example.com'],
	])('normalizes %s consistently', (input, expected) => {
		expect(normalizeEmailIdentity(input)).toBe(expected);
	});

	it.each([
		'álîce@example.com',
		'aliſe@example.com',
		'K@example.com',
		'alice..stock@example.com',
		'.alice@example.com',
		'alice.@example.com',
		'alice@exa\u200bmple.com',
		'alice@exa mple.com',
		'alice@example.com.',
		'"alice"@example.com',
		'alice(comment)@example.com',
		'alice@@example.com',
		'alice@example.com/path',
		'alice@%65xample.com',
		'alice@example.com:443',
		'alice@127.0.0.1',
		'alice@host.123',
		'alice@[127.0.0.1]',
		`${'a'.repeat(65)}@example.com`,
		'alice\u0000@example.com',
		'alice@localhost',
		'',
	])('rejects unsupported or ambiguous identity %s', (input) => {
		expect(normalizeEmailIdentity(input)).toBeNull();
	});

	it('preserves provider-specific dots and plus addressing as distinct identities', () => {
		expect(
			new Set(
				['alice@example.com', 'a.lice@example.com', 'alice+stock@example.com'].map(
					normalizeEmailIdentity,
				),
			).size,
		).toBe(3);
	});

	it('applies the same policy to platform, organization and invitation DTOs', async () => {
		for (const target of [PlatformLoginDto, OwnerLoginDto]) {
			const input = plainToInstance(target, {
				email: 'ALICE@bücher.example',
				password: 'legacy password',
			});
			expect(input.email).toBe('alice@xn--bcher-kva.example');
			expect(await validate(input)).toEqual([]);
		}
		const invitation = plainToInstance(CreateOwnerInvitationDto, {
			email: 'ALICE@bücher.example',
			displayName: 'Aline Uwase',
		});
		expect(invitation.email).toBe('alice@xn--bcher-kva.example');
		expect(await validate(invitation)).toEqual([]);
	});
});
