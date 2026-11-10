import { normalizedAuthority } from '../../src/modules/owner/auth/organization-routing.service.js';

describe('organization request authority parsing', () => {
	it.each(
		[
			undefined,
			'',
			'https://api.akiba.com',
			'api.akiba.com@attacker.example',
			'api.akiba.com/path',
			'api.akiba.com?organizationId=other',
			'api.akiba.com, companyb.akiba.com',
			'api.akiba.com.',
			'api..akiba.com',
			'api.akiba.com\r\nX-Forwarded-Host: companyb.akiba.com',
			'api.akiba.com:65536',
			['api.akiba.com', 'companyb.akiba.com'],
		].map((value) => ({ value })),
	)('rejects ambiguous or injected authorities', ({ value }) => {
		expect(normalizedAuthority(value)).toBeNull();
	});

	it('normalizes ordinary dns casing without changing the selected authority', () => {
		expect(normalizedAuthority('API.AKIBA.COM:443')).toBe('api.akiba.com');
		expect(normalizedAuthority('localhost:3000')).toBe('localhost:3000');
	});
});
