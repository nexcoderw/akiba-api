import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

import { ValidateBy, type ValidationOptions } from 'class-validator';

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const BOUNDARY_SPACE = /^[\s\u0085]+|[\s\u0085]+$/gu;

/** Case-insensitive ASCII local parts; NFC/IDNA domains become ASCII before indexed lookup.
 * Dots and plus addressing remain significant. Quoted local parts and SMTPUTF8 are unsupported.
 */
export function normalizeEmailIdentity(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 512) return null;
	const input = value.replace(BOUNDARY_SPACE, '');
	const parts = input.split('@');
	const local = parts[0];
	const domain = parts[1];
	if (
		parts.length !== 2 ||
		local === undefined ||
		domain === undefined ||
		local.length > 64 ||
		!LOCAL_PART.test(local) ||
		!/^[\p{L}\p{M}\p{N}.-]+$/u.test(domain)
	)
		return null;
	let ascii: string;
	try {
		ascii = domainToASCII(domain.normalize('NFC')).toLowerCase();
	} catch {
		return null;
	}
	const labels = ascii.split('.');
	if (
		isIP(ascii) !== 0 ||
		!/[a-z]/u.test(labels.at(-1) ?? '') ||
		labels.length < 2 ||
		labels.some((label) => !DOMAIN_LABEL.test(label))
	)
		return null;
	const normalized = `${local.toLowerCase()}@${ascii}`;
	return normalized.length <= 254 ? normalized : null;
}

/** Invalid values remain available to the validator, never converted into valid empty identities. */
export function transformEmailIdentity(value: unknown): unknown {
	return normalizeEmailIdentity(value) ?? value;
}

export function IsEmailIdentity(options?: ValidationOptions): PropertyDecorator {
	return ValidateBy(
		{
			name: 'isEmail',
			validator: {
				validate: (value: unknown) => normalizeEmailIdentity(value) !== null,
				defaultMessage: () => 'Enter a valid email address.',
			},
		},
		options,
	);
}
