import { openOwnerSession, sealOwnerSession } from '../../src/modules/owner/auth/owner-session-cookie.js';

const key = Buffer.alloc(32, 7);
const token = 'a'.repeat(43);
const a = 'https://musomesa.akiba.com';
const b = 'https://companyb.akiba.com';

describe('origin-bound organization session credentials', () => {
	it('cannot replay a valid credential at another portal or with another key', () => {
		const cookie = sealOwnerSession(token, a, key);
		expect(openOwnerSession(cookie, a, key)).toBe(token);
		expect(openOwnerSession(cookie, b, key)).toBeUndefined();
		expect(openOwnerSession(cookie, a, Buffer.alloc(32, 8))).toBeUndefined();
	});
	it.each([undefined, token, `${token}.invalid`, 'secret-cookie', ''.padEnd(1000, 'x')])(
		'rejects missing, legacy or malformed credentials', (value) => {
			expect(openOwnerSession(value, a, key)).toBeUndefined();
		},
	);
});
