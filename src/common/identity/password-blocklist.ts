import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { ApiProblemException } from '../errors/api-problem.exception.js';

const MAXIMUM_DATASET_BYTES = 16 * 1024 * 1024;
const MINIMUM_PRODUCTION_ENTRIES = 10_000;
const COMMON_VALUES = new Set([
	'passwordpassword',
	'passwordpasswordpassword',
	'password123456789',
	'123456789012345',
	'1234567890123456',
	'qwertyuiopasdfgh',
	'qwertyuiopasdfghjkl',
	'letmeinletmeinletmein',
	'correct horse battery staple',
	'this is a password',
	'thisismypassword',
	'iloveyouiloveyou',
	'welcome123456789',
	'akibaakibaakiba',
	...Array.from({ length: 1010 }, (_, index) => ' '.repeat(index + 15)),
]);

/** Offline whole-secret comparisons. Production creation fails closed without a reviewed corpus.
 * Dataset lines are SHA-256 indexes of NFC/lowercase values, never stored credential hashes.
 * Corpus size/integrity checks do not certify the operator's choice of breach data or freshness.
 */
export class PasswordBlocklist {
	private dataset: Promise<ReadonlySet<string>> | undefined;

	constructor(
		private readonly file: string | null,
		private readonly expectedDigest: string | null,
		private readonly production: boolean,
	) {}

	async assertAcceptable(password: string): Promise<void> {
		const normalized = password.normalize('NFC').toLowerCase();
		if (COMMON_VALUES.has(normalized)) throw new ApiProblemException('PASSWORD_POLICY_VIOLATION');
		this.dataset ??= this.load();
		const entries = await this.dataset;
		const fingerprint = createHash('sha256').update(normalized, 'utf8').digest('hex');
		if (entries.has(fingerprint)) throw new ApiProblemException('PASSWORD_POLICY_VIOLATION');
	}

	private async load(): Promise<ReadonlySet<string>> {
		if (this.file === null && !this.production) return new Set();
		if (this.file === null || this.expectedDigest === null) {
			throw new ApiProblemException('PASSWORD_POLICY_UNAVAILABLE');
		}
		try {
			const metadata = await stat(this.file);
			if (!metadata.isFile() || metadata.size > MAXIMUM_DATASET_BYTES)
				throw new Error('Invalid corpus.');
			const bytes = await readFile(this.file);
			if (
				bytes.length > MAXIMUM_DATASET_BYTES ||
				createHash('sha256').update(bytes).digest('hex') !== this.expectedDigest
			)
				throw new Error('Invalid corpus.');
			const lines = bytes
				.toString('utf8')
				.split(/\r?\n/u)
				.filter((line) => line !== '');
			if (lines.some((line) => !/^[a-f0-9]{64}$/u.test(line))) throw new Error('Invalid corpus.');
			const entries = new Set(lines);
			if (entries.size < (this.production ? MINIMUM_PRODUCTION_ENTRIES : 1))
				throw new Error('Invalid corpus.');
			return entries;
		} catch {
			throw new ApiProblemException('PASSWORD_POLICY_UNAVAILABLE');
		}
	}
}
