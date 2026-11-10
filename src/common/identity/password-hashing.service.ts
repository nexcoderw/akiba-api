import { isUtf8 } from 'node:buffer';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { argon2id, hash as argonHash, verify as argonVerify } from 'argon2';

import type { EnvironmentVariables } from '../../config/environment.types.js';
import { ApiProblemException } from '../errors/api-problem.exception.js';
import { PasswordBlocklist } from './password-blocklist.js';
import { MAXIMUM_PASSWORD_BYTES, normalizeNewPassword } from './password-policy.js';

interface HashParameters {
	readonly type: typeof argon2id;
	readonly memoryCost: number;
	readonly timeCost: number;
	readonly parallelism: number;
}
const CURRENT_PARAMETERS: HashParameters = Object.freeze({
	type: argon2id,
	memoryCost: 65_536,
	timeCost: 3,
	parallelism: 1,
});
const PHC =
	/^\$argon2id\$v=19\$m=([1-9][0-9]{0,5}),t=([1-9][0-9]?),p=([1-9][0-9]?)\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{43})$/u;
const MAXIMUM_CONCURRENT_OPERATIONS = 2;

function parameters(
	value: string,
): { memory: number; iterations: number; parallelism: number } | null {
	if (value.length > 255) return null;
	const match = PHC.exec(value);
	if (match === null) return null;
	const memory = Number(match[1]);
	const iterations = Number(match[2]);
	const parallelism = Number(match[3]);
	const salt = match[4];
	const digest = match[5];
	if (
		salt === undefined ||
		digest === undefined ||
		Buffer.from(salt, 'base64').toString('base64').replace(/=+$/u, '') !== salt ||
		Buffer.from(digest, 'base64').toString('base64').replace(/=+$/u, '') !== digest ||
		memory < 19_456 ||
		memory > 262_144 ||
		iterations < 2 ||
		iterations > 6 ||
		parallelism > 4
	)
		return null;
	return { memory, iterations, parallelism };
}

/** Shared by platform and organization workflows. No password or hash is logged or serialized.
 * Two in-flight Argon2 jobs bound memory; excess work fails promptly rather than building a queue.
 */
@Injectable()
export class PasswordHashingService {
	readonly dummyHash: string;
	private readonly blocklist: PasswordBlocklist;
	private active = 0;

	constructor(config: ConfigService<EnvironmentVariables, true>) {
		this.dummyHash = config.get('PLATFORM_AUTH_DUMMY_PASSWORD_HASH', { infer: true });
		if (parameters(this.dummyHash) === null || this.needsRehash(this.dummyHash, 'nfc')) {
			throw new Error('PLATFORM_AUTH_DUMMY_PASSWORD_HASH must use current Argon2id parameters.');
		}
		this.blocklist = new PasswordBlocklist(
			config.get('PASSWORD_BLOCKLIST_FILE', { infer: true }),
			config.get('PASSWORD_BLOCKLIST_SHA256', { infer: true }),
			config.get('NODE_ENV', { infer: true }) === 'production',
		);
	}

	async hash(password: Buffer): Promise<string> {
		return this.createHash(password, CURRENT_PARAMETERS);
	}

	/** Rehash a verified secret without applying creation policy or changing its representation. */
	async hashForUpgrade(
		password: Buffer,
		previousHash: string,
		normalization = 'raw',
	): Promise<string> {
		const previous = parameters(previousHash);
		if (
			previous === null ||
			!['raw', 'nfc'].includes(normalization) ||
			password.length > MAXIMUM_PASSWORD_BYTES ||
			!isUtf8(password)
		) {
			throw new ApiProblemException('ACCOUNT_ACTION_UNAVAILABLE');
		}
		const submitted = password.toString('utf8');
		const candidate = normalization === 'nfc' ? submitted.normalize('NFC') : submitted;
		return this.execute(() =>
			argonHash(candidate, {
				type: argon2id,
				memoryCost: Math.max(previous.memory, CURRENT_PARAMETERS.memoryCost),
				timeCost: Math.max(previous.iterations, CURRENT_PARAMETERS.timeCost),
				parallelism: previous.parallelism,
			}),
		);
	}

	private async createHash(password: Buffer, policy: HashParameters): Promise<string> {
		if (password.length > MAXIMUM_PASSWORD_BYTES || !isUtf8(password)) {
			throw new ApiProblemException('PASSWORD_POLICY_VIOLATION');
		}
		const normalized = normalizeNewPassword(password.toString('utf8'));
		if (normalized === null) throw new ApiProblemException('PASSWORD_POLICY_VIOLATION');
		await this.blocklist.assertAcceptable(normalized);
		return this.execute(() => argonHash(normalized, policy));
	}

	async verify(passwordHash: string, password: string, normalization = 'raw'): Promise<boolean> {
		if (Buffer.byteLength(password, 'utf8') > MAXIMUM_PASSWORD_BYTES || /\p{Cs}/u.test(password))
			return false;
		const usable = parameters(passwordHash) !== null && ['raw', 'nfc'].includes(normalization);
		const candidate = normalization === 'nfc' ? password.normalize('NFC') : password;
		return this.execute(async () => {
			try {
				const matched = await argonVerify(usable ? passwordHash : this.dummyHash, candidate);
				return usable && passwordHash !== this.dummyHash && matched;
			} catch {
				return false;
			}
		});
	}

	needsRehash(passwordHash: string, normalization = 'raw'): boolean {
		const parsed = parameters(passwordHash);
		return (
			parsed === null ||
			!['raw', 'nfc'].includes(normalization) ||
			parsed.memory < CURRENT_PARAMETERS.memoryCost ||
			parsed.iterations < CURRENT_PARAMETERS.timeCost
		);
	}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		if (this.active >= MAXIMUM_CONCURRENT_OPERATIONS)
			throw new ApiProblemException('PASSWORD_POLICY_UNAVAILABLE');
		this.active += 1;
		try {
			return await operation();
		} finally {
			this.active -= 1;
		}
	}
}
