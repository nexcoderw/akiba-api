import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildEnvironment,
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
