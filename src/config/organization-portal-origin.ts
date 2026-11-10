import { isOrganizationSlug } from '../common/organization/organization-slug.js';

export interface OrganizationPortalOriginPolicy {
	readonly fixedOrigin: string | null;
	readonly baseDomain: string | null;
}

export function parseOrganizationPortalOriginPolicy(
	input: Record<string, unknown>,
	production: boolean,
	fallbackOrigin = 'http://localhost:4001',
): OrganizationPortalOriginPolicy {
	if (!production) {
		if (input.ORGANIZATION_PORTAL_BASE_DOMAIN !== undefined) {
			const value = input.ORGANIZATION_PORTAL_BASE_DOMAIN;
			if (typeof value !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost$/u.test(value) ||
				input.ORGANIZATION_PORTAL_ORIGIN !== undefined) {
				throw new Error('ORGANIZATION_PORTAL_BASE_DOMAIN is production-only except explicit .localhost domains.');
			}
			return { fixedOrigin: null, baseDomain: value };
		}
		const fixedOrigin = exactOrigin(
			input.ORGANIZATION_PORTAL_ORIGIN ?? fallbackOrigin,
			'ORGANIZATION_PORTAL_ORIGIN',
		);
		return { fixedOrigin, baseDomain: null };
	}

	if (input.ORGANIZATION_PORTAL_ORIGIN !== undefined) {
		throw new Error(
			'Production uses ORGANIZATION_PORTAL_BASE_DOMAIN instead of a fixed portal origin.',
		);
	}
	const value = input.ORGANIZATION_PORTAL_BASE_DOMAIN;
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error('ORGANIZATION_PORTAL_BASE_DOMAIN is required.');
	}
	const baseDomain = value.trim().toLowerCase();
	if (
		baseDomain.length > 253 ||
		baseDomain.endsWith('.invalid') ||
		baseDomain.endsWith('.test') ||
		baseDomain.endsWith('.localhost') ||
		baseDomain === 'localhost' ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(baseDomain)
	) {
		throw new Error('ORGANIZATION_PORTAL_BASE_DOMAIN must be a production DNS base domain.');
	}
	return { fixedOrigin: null, baseDomain };
}

export function organizationSlugFromPortalOrigin(
	value: string | undefined,
	policy: OrganizationPortalOriginPolicy,
): string | null {
	if (value === undefined) return null;
	// Development has one shared origin, so there is no tenant label to extract.
	if (policy.fixedOrigin !== null) return null;
	if (policy.baseDomain === null) return null;

	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		return null;
	}
	if (
		origin.origin !== value ||
		(origin.protocol !== 'https:' && !(policy.baseDomain.endsWith('.localhost') && origin.protocol === 'http:')) ||
		(origin.port !== '' && !policy.baseDomain.endsWith('.localhost')) ||
		origin.username !== '' ||
		origin.password !== '' ||
		origin.pathname !== '/' ||
		origin.search !== '' ||
		origin.hash !== ''
	) {
		return null;
	}

	const suffix = `.${policy.baseDomain}`;
	if (!origin.hostname.endsWith(suffix)) return null;
	const slug = origin.hostname.slice(0, -suffix.length);
	return slug.includes('.') || !isOrganizationSlug(slug) ? null : slug;
}

export function isOrganizationPortalOrigin(
	value: string | undefined,
	policy: OrganizationPortalOriginPolicy,
): boolean {
	if (policy.fixedOrigin !== null) return value === policy.fixedOrigin;
	return organizationSlugFromPortalOrigin(value, policy) !== null;
}

export function organizationPortalOriginForSlug(
	slug: string,
	policy: OrganizationPortalOriginPolicy,
): string {
	if (!isOrganizationSlug(slug)) throw new Error('Organization portal slug is invalid.');
	if (policy.fixedOrigin !== null) return policy.fixedOrigin;
	if (policy.baseDomain === null) throw new Error('Organization portal origin is unavailable.');
	return `https://${slug}.${policy.baseDomain}`;
}

function exactOrigin(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required.`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid absolute origin.`);
	}
	if (url.origin !== value || !['http:', 'https:'].includes(url.protocol)) {
		throw new Error(`${name} must be an HTTP origin without a path.`);
	}
	if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
		throw new Error(`${name} may use HTTP only on a loopback host.`);
	}
	return url.origin;
}
