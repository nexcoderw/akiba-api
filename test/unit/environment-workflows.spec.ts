import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

async function readRootFile(name: string): Promise<string> {
	return await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
}

describe('API workflow environment boundaries', () => {
	it('uses an explicit development Neon placeholder without provisioning an extra database', async () => {
		const runtime = parseEnv(await readRootFile('.env.local.example'));
		if (runtime.DATABASE_URL === undefined) throw new Error('Missing runtime URL placeholder.');
		const url = new URL(runtime.DATABASE_URL);
		expect(url.hostname.toLowerCase()).toBe('development_pooler_host');
		expect(url.pathname).toBe('/NEON_DATABASE');
		expect(url.username).toBe('NEON_USER');
		expect(url.searchParams.get('sslmode')).toBe('require');
	});

	it('keeps unsupported legacy operator and live-test profiles disabled without target credentials', async () => {
		for (const file of ['.env.bootstrap.local.example', '.env.bootstrap-test.local.example']) {
			const profile = parseEnv(await readRootFile(file));
			expect(profile.PLATFORM_OWNER_BOOTSTRAP_ENABLED).toBe('false');
			expect(profile.DATABASE_URL).toBeUndefined();
			expect(profile.BOOTSTRAP_TEST_DATABASE_URL).toBeUndefined();
			expect(profile.PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE).toBeUndefined();
		}
		const tests = parseEnv(await readRootFile('.env.bootstrap-test.local.example'));
		expect(tests.NODE_ENV).toBe('test');
		expect(tests.BOOTSTRAP_POSTGRES_TESTS).toBe('0');
	});

	it('routes bootstrap startup failures to the CLI handler without enabling raw logs', async () => {
		const cli = await readRootFile('src/cli/platform-owner-bootstrap.ts');
		const options = /createApplicationContext\(PlatformBootstrapCliModule,\s*\{([^}]*)\}/u.exec(
			cli,
		);
		expect(options?.[1]).toContain('logger: false');
		expect(options?.[1]).toContain('abortOnError: false');
	});

	it('keeps operator and test targets out of normal application templates', async () => {
		for (const file of ['.env.local.example', '.env.production.example']) {
			const runtime = parseEnv(await readRootFile(file));
			expect(runtime.PLATFORM_OWNER_BOOTSTRAP_ENABLED).toBe('false');
			expect(runtime.BOOTSTRAP_TEST_DATABASE_URL).toBeUndefined();
			expect(runtime.BOOTSTRAP_TEST_DATABASE_MARKER).toBeUndefined();
			expect(runtime.PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE).toBeUndefined();
		}
	});
});
