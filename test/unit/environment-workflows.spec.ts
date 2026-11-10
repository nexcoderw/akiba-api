import { readFile, readdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';

async function readRootFile(name: string): Promise<string> {
	return await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
}

describe('API workflow environment boundaries', () => {
	it('tracks only the development and production environment templates', async () => {
		const files = await readdir(new URL('../../', import.meta.url));
		expect(
			files.filter((name) => name.startsWith('.env') && name.endsWith('.example')).sort(),
		).toEqual(['.env.local.example', '.env.production.example']);
	});

	it.each([
		['.env.local.example', 'development', 'development_pooler_host'],
		['.env.production.example', 'production', 'production_pooler_host'],
	])('uses the existing pooled connection in %s', async (file, environment, host) => {
		const runtime = parseEnv(await readRootFile(file));
		if (runtime.DATABASE_URL === undefined) throw new Error('Missing runtime URL placeholder.');
		const url = new URL(runtime.DATABASE_URL);
		expect(runtime.NODE_ENV).toBe(environment);
		expect(url.hostname.toLowerCase()).toBe(host);
		expect(url.pathname).toBe('/NEON_DATABASE');
		expect(url.username).toBe('NEON_USER');
		expect(url.searchParams.get('sslmode')).toBe('verify-full');
		expect(runtime.PLATFORM_OWNER_BOOTSTRAP_ENABLED).toBe('false');
		expect(
			Object.keys(runtime)
				.filter((name) => name.includes('DATABASE'))
				.sort(),
		).toEqual([
			'DATABASE_CONNECTION_TIMEOUT_MS',
			'DATABASE_POOL_MAX',
			'DATABASE_URL',
			'OWNER_INVITATION_DELIVERY_DATABASE_APPROVED',
		]);
	});

	it('routes bootstrap startup failures to the CLI handler without enabling raw logs', async () => {
		const cli = await readRootFile('src/cli/platform-owner-bootstrap.ts');
		const options = /createApplicationContext\(PlatformBootstrapCliModule,\s*\{([^}]*)\}/u.exec(
			cli,
		);
		expect(options?.[1]).toContain('logger: false');
		expect(options?.[1]).toContain('abortOnError: false');
	});
});
