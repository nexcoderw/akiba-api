import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = 'akiba-render-build-v1\n';

class RenderBuildError extends Error {}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} directory @returns {Record<string, unknown>} */
function manifest(directory) {
	/** @type {unknown} */
	const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
	if (!record(value)) throw new RenderBuildError('Invalid package manifest.');
	return value;
}

/** @param {unknown} value @returns {string} */
export function reviewedRevision(value) {
	if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
		throw new RenderBuildError(
			'Set AKIBA_DB_SOURCE_REVISION to an operator-reviewed immutable database commit.',
		);
	}
	return value;
}

/** Build dependencies never receive application credentials or the source-read token.
 * @param {NodeJS.ProcessEnv} source @param {string} configurationDirectory
 * @returns {NodeJS.ProcessEnv}
 */
export function buildEnvironment(source, configurationDirectory) {
	mkdirSync(configurationDirectory, { recursive: true });
	const userConfig = join(configurationDirectory, 'user.npmrc');
	const globalConfig = join(configurationDirectory, 'global.npmrc');
	// npm rejects loading the same path at two configuration levels, including /dev/null.
	writeFileSync(userConfig, '', { mode: 0o600 });
	writeFileSync(globalConfig, '', { mode: 0o600 });
	/** @type {NodeJS.ProcessEnv} */
	const env = {
		CI: 'true',
		NODE_ENV: 'production',
		PRISMA_SKIP_POSTINSTALL_GENERATE: 'true',
		NPM_CONFIG_USERCONFIG: userConfig,
		NPM_CONFIG_GLOBALCONFIG: globalConfig,
		NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
	};
	for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP']) {
		if (source[key] !== undefined) env[key] = source[key];
	}
	return env;
}

/** Refuse to remove anything except this script's marked generated artifact.
 * @param {string} directory @returns {void}
 */
export function prepareArtifact(directory) {
	if (existsSync(directory)) {
		const stamp = join(directory, '.akiba-render-build');
		if (
			!lstatSync(directory).isDirectory() ||
			lstatSync(directory).isSymbolicLink() ||
			!existsSync(stamp) ||
			!lstatSync(stamp).isFile() ||
			lstatSync(stamp).isSymbolicLink() ||
			readFileSync(stamp, 'utf8') !== marker
		)
			throw new RenderBuildError('Refusing to replace an unrecognized .render directory.');
		rmSync(directory, { recursive: true });
	}
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, '.akiba-render-build'), marker, { mode: 0o600 });
}

/** @param {string} executable @param {string[]} args @param {string} cwd
 * @param {NodeJS.ProcessEnv} env @param {string} label @returns {void}
 */
function run(executable, args, cwd, env, label) {
	process.stdout.write(`Akiba build: ${label}\n`);
	// Never stream git diagnostics: its process temporarily receives a read credential.
	const result = spawnSync(executable, args, {
		cwd,
		env,
		stdio: executable === 'git' ? 'pipe' : 'inherit',
		timeout: 600_000,
	});
	if (result.error || result.status !== 0)
		throw new RenderBuildError(`Build step failed: ${label}.`);
}

/** @param {string} directory @param {string} expected @returns {void} */
function requirePackage(directory, expected) {
	if (manifest(directory).name !== expected)
		throw new RenderBuildError('Unexpected database package identity.');
}

/** @param {string} directory @returns {string} */
function requirePrisma7(directory) {
	const cli = manifest(join(directory, 'node_modules/prisma')).version;
	const client = manifest(join(directory, 'node_modules/@prisma/client')).version;
	if (typeof cli !== 'string' || !/^7\.\d+\.\d+$/u.test(cli) || cli !== client) {
		throw new RenderBuildError(
			'The database checkout must install matching Prisma 7 CLI and Client versions.',
		);
	}
	return cli;
}

/** file: siblings resolve from their real directory, not the consumer's node_modules.
 * Share the consumer's peer instances after its final production install.
 * @param {string} api @param {string} database @returns {void}
 */
export function linkRuntimePeers(api, database) {
	const peers = manifest(database).peerDependencies;
	const dependencies = manifest(api).dependencies;
	if (!record(peers) || !record(dependencies)) {
		throw new RenderBuildError('Runtime dependency declarations are missing.');
	}
	for (const name of Object.keys(peers)) {
		if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
			throw new RenderBuildError('Invalid database peer package name.');
		}
		const target = join(api, 'node_modules', name);
		if (typeof dependencies[name] !== 'string' || !existsSync(join(target, 'package.json'))) {
			throw new RenderBuildError(`API runtime dependency is missing for database peer: ${name}.`);
		}
		if (manifest(target).name !== name) {
			throw new RenderBuildError('Runtime peer package identity does not match.');
		}
		const destination = join(database, 'node_modules', name);
		mkdirSync(dirname(destination), { recursive: true });
		// Only called on generated artifact directories, never the operator's installed packages.
		rmSync(destination, { recursive: true, force: true });
		symlinkSync(relative(dirname(destination), target), destination, 'dir');
	}
}

/** @returns {void} */
export function buildRenderArtifact() {
	const [major, minor] = process.versions.node.split('.').map(Number);
	if (major !== 22 || minor === undefined || minor < 12) {
		throw new RenderBuildError('Use Node >=22.12.0 <23; set Render NODE_VERSION=22.');
	}
	const revision = reviewedRevision(process.env.AKIBA_DB_SOURCE_REVISION);
	const token = process.env.DB_REPOSITORY_READ_TOKEN;
	if (!token || /[\r\n]/u.test(token))
		throw new RenderBuildError('Set the protected DB_REPOSITORY_READ_TOKEN build credential.');
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const artifact = join(root, '.render');
	const source = join(artifact, 'source-db');
	const database = join(artifact, 'db');
	const api = join(artifact, 'api');
	prepareArtifact(artifact);
	const env = buildEnvironment(process.env, join(artifact, 'npm-config'));
	mkdirSync(source);
	const gitEnv = {
		...env,
		GIT_TERMINAL_PROMPT: '0',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
	};
	run('git', ['init', '--quiet'], source, gitEnv, 'initialize canonical database checkout');
	run(
		'git',
		['remote', 'add', 'origin', 'https://github.com/nexcoderw/akiba-db.git'],
		source,
		gitEnv,
		'set fixed database repository',
	);
	run(
		'git',
		['fetch', '--quiet', '--depth=1', 'origin', revision],
		source,
		gitEnv,
		'fetch reviewed database revision',
	);
	run(
		'git',
		['checkout', '--quiet', '--detach', revision],
		source,
		gitEnv,
		'check out reviewed database revision',
	);
	requirePackage(source, '@nexcoderw/akiba-db');
	run('npm', ['ci', '--include=dev'], source, env, 'install locked database build dependencies');
	const prisma = requirePrisma7(source);
	// Only the canonical source checkout owns schema generation. No URL or database access is supplied.
	run('npm', ['run', 'prisma:generate'], source, env, 'generate canonical Prisma 7 client offline');
	run('npm', ['run', 'build'], source, env, 'compile canonical database package');
	mkdirSync(database);
	for (const name of ['package.json', 'package-lock.json', 'dist']) {
		cpSync(join(source, name), join(database, name), { recursive: true });
	}
	run('npm', ['ci', '--omit=dev'], database, env, 'install locked database runtime dependencies');
	if (manifest(join(database, 'node_modules/@prisma/client')).version !== prisma) {
		throw new RenderBuildError(
			'Database runtime Client differs from the generated Prisma version.',
		);
	}
	mkdirSync(api);
	// Keep both sibling packages inside Render's retained service root. Never copy .env files.
	for (const name of [
		'package.json',
		'package-lock.json',
		'nest-cli.json',
		'tsconfig.json',
		'tsconfig.build.json',
		'src',
	]) {
		cpSync(join(root, name), join(api, name), { recursive: true });
	}
	const dependencies = manifest(api).dependencies;
	if (!record(dependencies) || dependencies['@nexcoderw/akiba-db'] !== 'file:../db') {
		throw new RenderBuildError('This build requires the reviewed file:../db integration.');
	}
	run('npm', ['ci', '--include=dev'], api, env, 'install locked API build dependencies');
	run('npm', ['run', 'build'], api, env, 'compile API');
	run('npm', ['ci', '--omit=dev'], api, env, 'install locked API runtime dependencies');
	linkRuntimePeers(api, database);
	run(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			"const db = await import('@nexcoderw/akiba-db'); if (![db.DatabaseModule, db.PrismaService, db.PrismaClient].every(value => typeof value === 'function')) process.exit(1);",
		],
		api,
		env,
		'verify canonical runtime exports without constructing a database client',
	);
	if (!existsSync(join(api, 'dist/main.js')))
		throw new RenderBuildError('Compiled API entry point is missing.');
	rmSync(source, { recursive: true });
	writeFileSync(
		join(artifact, 'build.json'),
		`${JSON.stringify({ databaseRevision: revision, prisma, node: process.versions.node })}\n`,
	);
	process.stdout.write(
		'Akiba build complete. Start with: npm --prefix .render/api run start:prod\n',
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		buildRenderArtifact();
	} catch (error) {
		// Only intentional fixed diagnostics are safe to display; filesystem errors may contain paths.
		process.stderr.write(
			`${error instanceof RenderBuildError ? error.message : 'Render build failed; inspect the last completed build step.'}\n`,
		);
		process.exitCode = 1;
	}
}
