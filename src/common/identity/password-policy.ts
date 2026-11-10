import { isUtf8 } from 'node:buffer';

export const MINIMUM_PASSWORD_CHARACTERS = 15;
export const MAXIMUM_PASSWORD_CHARACTERS = 1024;
export const MAXIMUM_PASSWORD_BYTES = 4096;

/** New secrets use NFC and Unicode code-point lengths; whitespace is preserved, never trimmed.
 * Legacy raw credentials are verified with their recorded normalization instead of silently reset.
 */
export function normalizeNewPassword(value: string): string | null {
	if (value.length > MAXIMUM_PASSWORD_BYTES || /[\p{Cc}\p{Cs}]/u.test(value)) return null;
	const normalized = value.normalize('NFC');
	const length = [...normalized].length;
	return length >= MINIMUM_PASSWORD_CHARACTERS &&
		length <= MAXIMUM_PASSWORD_CHARACTERS &&
		Buffer.byteLength(normalized, 'utf8') <= MAXIMUM_PASSWORD_BYTES
		? normalized
		: null;
}

export function acceptsPasswordCreation(password: Buffer, normalizedEmail: string): boolean {
	if (password.length > MAXIMUM_PASSWORD_BYTES || !isUtf8(password)) return false;
	const value = normalizeNewPassword(password.toString('utf8'));
	if (value === null) return false;
	const candidate = value.toLowerCase();
	return candidate !== normalizedEmail.toLowerCase() && candidate !== normalizedEmail.split('@')[0];
}
