import {
	isOrganizationPortalOrigin,
	parseOrganizationPortalOriginPolicy,
	organizationPortalOriginForSlug,
	organizationSlugFromPortalOrigin,
} from '../../src/config/organization-portal-origin.js';

describe('organization portal origin policy', () => {
	const productionPolicy = { fixedOrigin: null, baseDomain: 'akiba.com' };

	it.each(['kimihurura', 'diamond-supplies', 'kigali-trading'])(
		'accepts one valid organization slug: %s',
		(slug) => {
			const origin = `https://${slug}.akiba.com`;
			expect(isOrganizationPortalOrigin(origin, productionPolicy)).toBe(true);
			expect(organizationSlugFromPortalOrigin(origin, productionPolicy)).toBe(slug);
			expect(organizationPortalOriginForSlug(slug, productionPolicy)).toBe(origin);
		},
	);

	it.each([
		'http://kimihurura.akiba.com',
		'https://akiba.com',
		'https://admin.akiba.com',
		'https://api.akiba.com',
		'https://notify.akiba.com',
		'https://branch.kimihurura.akiba.com',
		'https://kimihurura.akiba.com.attacker.example',
		'https://kimihurura.akiba.com:444',
		'https://kimihurura.akiba.com/path',
	])('rejects an unsafe production origin: %s', (origin) => {
		expect(isOrganizationPortalOrigin(origin, productionPolicy)).toBe(false);
		expect(organizationSlugFromPortalOrigin(origin, productionPolicy)).toBeNull();
	});

	it('keeps local development on the configured exact origin', () => {
		const localPolicy = { fixedOrigin: 'http://localhost:4001', baseDomain: null };
		expect(isOrganizationPortalOrigin('http://localhost:4001', localPolicy)).toBe(true);
		expect(isOrganizationPortalOrigin('http://kimihurura.localhost:4001', localPolicy)).toBe(false);
		expect(organizationPortalOriginForSlug('kimihurura', localPolicy)).toBe(
			'http://localhost:4001',
		);
	});

	it('keeps fixed origins local and base-domain routing production-only', () => {
		expect(() =>
			parseOrganizationPortalOriginPolicy(
				{ ORGANIZATION_PORTAL_BASE_DOMAIN: 'example.com' },
				false,
			),
		).toThrow('production-only');
		expect(() =>
			parseOrganizationPortalOriginPolicy(
				{ ORGANIZATION_PORTAL_ORIGIN: 'https://kimihurura.example.com' },
				true,
			),
		).toThrow('instead of a fixed portal origin');
	});
});
