import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, argon2id } from 'argon2';

import { PasswordBlocklist } from '../../src/common/identity/password-blocklist.js';
import { PasswordHashingService } from '../../src/common/identity/password-hashing.service.js';
import { normalizeNewPassword } from '../../src/common/identity/password-policy.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import type { EnvironmentVariables } from '../../src/config/environment.types.js';

jest.setTimeout(30_000);

function hashing(): PasswordHashingService {
	return new PasswordHashingService(
		new ConfigService<EnvironmentVariables, true>(validateEnvironment({ NODE_ENV: 'test' })),
	);
}

describe('password credential foundation', () => {
	it('uses unique salts and the current strong PHC configuration', async () => {
		const service = hashing();
		const secret = Buffer.from('Nyungwe lanterns cross quiet rivers');
		const [first, second] = await Promise.all([service.hash(secret), service.hash(secret)]);
		expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
		expect(first).not.toBe(second);
		expect(service.needsRehash(first, 'nfc')).toBe(false);
		expect(await service.verify(first, secret.toString('utf8'), 'nfc')).toBe(true);
		expect(await service.verify(first, 'a different fictional password', 'nfc')).toBe(false);
	});

	it('uses NFC consistently without trimming or truncating the submitted secret', async () => {
		const service = hashing();
		const value = `  ${'é'.repeat(64)}  `;
		const passwordHash = await service.hash(Buffer.from(value.normalize('NFD')));
		expect(await service.verify(passwordHash, value, 'nfc')).toBe(true);
		expect(await service.verify(passwordHash, value.normalize('NFD'), 'nfc')).toBe(true);
		expect(await service.verify(passwordHash, value.trim(), 'nfc')).toBe(false);
		const long = `${'x'.repeat(1023)}a`;
		const longHash = await service.hash(Buffer.from(long));
		expect(await service.verify(longHash, long, 'nfc')).toBe(true);
		expect(await service.verify(longHash, `${'x'.repeat(1023)}b`, 'nfc')).toBe(false);
		expect(normalizeNewPassword('😀'.repeat(15))).not.toBeNull();
		expect(normalizeNewPassword('é'.repeat(1024))).not.toBeNull();
		expect(normalizeNewPassword('x'.repeat(14))).toBeNull();
		expect(normalizeNewPassword('x'.repeat(1025))).toBeNull();
		expect(normalizeNewPassword('valid fictional\u0000password')).toBeNull();
	});

	it('preserves verified raw legacy secrets and detects acceptable older costs', async () => {
		const service = hashing();
		const value = 'e\u0301'.repeat(8);
		const legacy = await argonHash(value, {
			type: argon2id,
			memoryCost: 19456,
			timeCost: 2,
			parallelism: 1,
		});
		expect(await service.verify(legacy, value, 'raw')).toBe(true);
		expect(await service.verify(legacy, value.normalize('NFC'), 'raw')).toBe(false);
		expect(service.needsRehash(legacy, 'raw')).toBe(true);
		const upgraded = await service.hashForUpgrade(Buffer.from(value), legacy, 'raw');
		expect(await service.verify(upgraded, value, 'raw')).toBe(true);
		expect(await service.verify(upgraded, value.normalize('NFC'), 'raw')).toBe(false);
		expect(service.needsRehash(upgraded, 'raw')).toBe(false);
		for (const invalid of [
			'plaintext',
			'$2b$legacy',
			'$argon2id$v=19$m=999999,t=99,p=9$salt$hash',
		]) {
			expect(await service.verify(invalid, value, 'raw')).toBe(false);
		}
	});

	it('rejects common secrets and bounds expensive work without weakening parameters', async () => {
		const service = hashing();
		await expect(service.hash(Buffer.from('correct horse battery staple'))).rejects.toMatchObject({
			publicCode: 'PASSWORD_POLICY_VIOLATION',
		});
		const outcomes = await Promise.allSettled(
			Array.from({ length: 3 }, () =>
				service.hash(Buffer.from('Gicumbi lanterns beyond silver hills')),
			),
		);
		expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
		expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
			reason: { publicCode: 'PASSWORD_POLICY_UNAVAILABLE' },
		});
		await expect(
			service.hash(Buffer.from('Nyanza notebooks beside quiet rivers')),
		).resolves.toMatch(/^\$argon2id\$/u);
	});

	it('fails production creation closed without a reviewed corpus', async () => {
		const list = new PasswordBlocklist(null, null, true);
		await expect(list.assertAcceptable('Fictional long passphrase')).rejects.toMatchObject({
			publicCode: 'PASSWORD_POLICY_UNAVAILABLE',
		});
	});

	it('checks a local breached-password index and rejects corrupt or undersized datasets', async () => {
		const root = await mkdtemp(join(tmpdir(), 'akiba-password-corpus-'));
		try {
			const file = join(root, 'corpus.sha256');
			const compromised = 'Fictional compromised passphrase';
			const fingerprint = (value: string): string =>
				createHash('sha256').update(value.normalize('NFC').toLowerCase()).digest('hex');
			const values = [
				fingerprint(compromised),
				...Array.from({ length: 9999 }, (_, index) =>
					fingerprint(`synthetic corpus entry ${String(index)}`),
				),
			];
			const data = `${values.join('\n')}\n`;
			await writeFile(file, data);
			const checksum = createHash('sha256').update(data).digest('hex');
			const list = new PasswordBlocklist(file, checksum, true);
			await expect(list.assertAcceptable(compromised)).rejects.toMatchObject({
				publicCode: 'PASSWORD_POLICY_VIOLATION',
			});
			await expect(
				list.assertAcceptable('Gisagara leaves beside the evening river'),
			).resolves.toBeUndefined();
			await expect(
				new PasswordBlocklist(file, '0'.repeat(64), true).assertAcceptable('long fictional value'),
			).rejects.toMatchObject({ publicCode: 'PASSWORD_POLICY_UNAVAILABLE' });
			await writeFile(file, `${fingerprint(compromised)}\n`);
			const small = createHash('sha256')
				.update(`${fingerprint(compromised)}\n`)
				.digest('hex');
			await expect(
				new PasswordBlocklist(file, small, true).assertAcceptable('long fictional value'),
			).rejects.toMatchObject({ publicCode: 'PASSWORD_POLICY_UNAVAILABLE' });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
