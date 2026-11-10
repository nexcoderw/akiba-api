import { createHmac, timingSafeEqual } from 'node:crypto';

/** Bind the browser credential to its verified portal origin without changing session persistence.
 * Old unbound cookies are deliberately rejected. Never return the underlying session token to clients.
 */
export function sealOwnerSession(token: string, origin: string, key: Buffer): string {
	const signature = createHmac('sha256', key)
		.update(JSON.stringify(['akiba-owner-cookie-origin-v1', origin, token]))
		.digest('base64url');
	return `${token}.${signature}`;
}

export function openOwnerSession(
	value: string | undefined,
	origin: unknown,
	key: Buffer,
): string | undefined {
	if (
		value === undefined ||
		typeof origin !== 'string' ||
		origin.length > 512 ||
		!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(value)
	)
		return undefined;
	const token = value.slice(0, 43);
	const expected = sealOwnerSession(token, origin, key);
	return timingSafeEqual(Buffer.from(value), Buffer.from(expected)) ? token : undefined;
}
