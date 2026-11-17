import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildEnvironment,
	linkRuntimePeers,
	prepareArtifact,
	reviewedRevision,
} from '../../scripts/render-build.mjs';

describe('Render build isolation', () => {
	let configurationDirectory: string;
	beforeEach(() => {
		configurationDirectory = mkdtempSync(join(tmpdir(), 'akiba-npm-config-'));
	});
	afterEach(() => {
		rmSync(configurationDirectory, { recursive: true, force: true });
	});
	it.each(['main', 'latest', '', undefined, 'a'.repeat(39), 'A'.repeat(40)])(
		'rejects mutable or malformed database revision %p',
		(value) => {
			expect(() => reviewedRevision(value)).toThrow();
		},
	);
	it('accepts an immutable source revision', () => {
		expect(reviewedRevision('a'.repeat(40))).toBe('a'.repeat(40));
	});
	it('does not pass application, Git, npm or tracing secrets to dependency scripts', () => {
		const env = buildEnvironment(
			{
				PATH: '/usr/bin',
				DATABASE_URL: 'synthetic-secret',
				DB_REPOSITORY_READ_TOKEN: 'synthetic-token',
				NODE_OPTIONS: '--require untrusted-hook',
				NPM_CONFIG_USERCONFIG: '/private/credentials',
				GIT_CONFIG_VALUE_0: 'synthetic-header',
			},
			configurationDirectory,
		);
		expect(env.PATH).toBe('/usr/bin');
		expect(env.NPM_CONFIG_USERCONFIG).toBe(join(configurationDirectory, 'user.npmrc'));
		expect(env.NPM_CONFIG_GLOBALCONFIG).toBe(join(configurationDirectory, 'global.npmrc'));
		expect(readFileSync(join(configurationDirectory, 'user.npmrc'), 'utf8')).toBe('');
		expect(readFileSync(join(configurationDirectory, 'global.npmrc'), 'utf8')).toBe('');
		for (const key of [
			'DATABASE_URL',
			'DB_REPOSITORY_READ_TOKEN',
			'NODE_OPTIONS',
			'GIT_CONFIG_VALUE_0',
		]) {
			expect(env[key]).toBeUndefined();
		}
	});
	it('allows npm to resolve isolated configuration without duplicate loading', () => {
		const env = buildEnvironment(process.env, configurationDirectory);
		const result = spawnSync('npm', ['config', 'get', 'registry'], {
			cwd: configurationDirectory,
			env,
			encoding: 'utf8',
			timeout: 30_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.stderr).not.toContain('double-loading');
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('https://registry.npmjs.org');
	});
	it('resolves database peers to the same API runtime instance without development dependencies', () => {
		const api = join(configurationDirectory, 'api');
		const database = join(configurationDirectory, 'db');
		const peer = join(api, 'node_modules/@nestjs/common');
		mkdirSync(peer, { recursive: true });
		mkdirSync(join(database, 'dist'), { recursive: true });
		writeFileSync(
			join(api, 'package.json'),
			JSON.stringify({
				type: 'module',
				dependencies: { '@nestjs/common': '^11.0.0' },
			}),
		);
		writeFileSync(
			join(database, 'package.json'),
			JSON.stringify({
				type: 'module',
				peerDependencies: { '@nestjs/common': '^11.0.0' },
			}),
		);
		writeFileSync(
			join(peer, 'package.json'),
			JSON.stringify({
				name: '@nestjs/common',
				type: 'module',
				exports: './index.js',
			}),
		);
		writeFileSync(join(peer, 'index.js'), 'export default {};');
		writeFileSync(join(database, 'dist/index.js'), "export { default } from '@nestjs/common';");
		const args = [
			'--input-type=module',
			'-e',
			"import a from '@nestjs/common'; import b from '../db/dist/index.js'; if (a !== b) process.exit(1);",
		];
		expect(spawnSync(process.execPath, args, { cwd: api }).status).not.toBe(0);
		linkRuntimePeers(api, database);
		const result = spawnSync(process.execPath, args, { cwd: api, encoding: 'utf8' });
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		// Linking again must safely replace existing links.
		linkRuntimePeers(api, database);
		expect(spawnSync(process.execPath, args, { cwd: api }).status).toBe(0);
	});
	it('rejects database peers absent from API runtime dependencies', () => {
		const api = join(configurationDirectory, 'api');
		const database = join(configurationDirectory, 'db');
		mkdirSync(api);
		mkdirSync(database);
		writeFileSync(join(api, 'package.json'), JSON.stringify({ dependencies: {} }));
		writeFileSync(
			join(database, 'package.json'),
			JSON.stringify({
				peerDependencies: { '@nestjs/common': '^11.0.0' },
			}),
		);
		expect(() => {
			linkRuntimePeers(api, database);
		}).toThrow('API runtime dependency is missing');
	});
	it('preserves unrecognized directories and rejects symlink targets', () => {
		const root = mkdtempSync(join(tmpdir(), 'akiba-render-'));
		try {
			const target = join(root, 'target');
			mkdirSync(target);
			writeFileSync(join(target, 'keep'), 'preserved');
			expect(() => {
				prepareArtifact(target);
			}).toThrow();
			expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('preserved');
			prepareArtifact(join(root, 'owned'));
			symlinkSync(join(root, 'owned'), join(root, 'link'));
			expect(() => {
				prepareArtifact(join(root, 'link'));
			}).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it('rebuilds only its own marked generated directory', () => {
		const root = mkdtempSync(join(tmpdir(), 'akiba-render-'));
		try {
			const output = join(root, 'artifact');
			prepareArtifact(output);
			writeFileSync(join(output, 'old-output'), 'generated');
			prepareArtifact(output);
			expect(() => readFileSync(join(output, 'old-output'))).toThrow();
			expect(readFileSync(join(output, '.akiba-render-build'), 'utf8')).toBe(
				'akiba-render-build-v1\n',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
