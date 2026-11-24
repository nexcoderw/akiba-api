import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class DatabaseRevisionError extends Error {}

/** Read the revision relative to this checkout so callers can use any working directory.
 * @param {string | URL} [path]
 * @returns {string}
 */
export function readDatabaseRevision(path = new URL('../akiba-db-revision.txt', import.meta.url)) {
	let contents;
	try {
		contents = readFileSync(path, 'utf8');
	} catch {
		throw new DatabaseRevisionError('Could not read the tracked akiba-db-revision.txt file.');
	}
	const revision = contents.replace(/\r?\n$/u, '');
	if (revision.length !== 40 || !/^[a-f0-9]{40}$/u.test(revision)) {
		throw new DatabaseRevisionError(
			'akiba-db-revision.txt must contain one reviewed, full lowercase DB commit SHA.',
		);
	}
	return revision;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.stdout.write(`${readDatabaseRevision()}\n`);
	} catch (error) {
		if (!(error instanceof DatabaseRevisionError)) throw error;
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}
