import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';

import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformLoginDto } from '../../src/modules/platform/auth/dto/platform-login.dto.js';
import { acceptsBootstrapPassword } from '../../src/modules/platform/auth/platform-password-policy.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import type { EnvironmentVariables } from '../../src/config/environment.types.js';

describe('future bootstrap password compatibility', () => {
	it.each([
		'A7!b2@Qx9#Za123',
		'a longer fictional password',
		'😀'.repeat(15),
		'é'.repeat(512),
		'x'.repeat(1024),
	])('accepts only credentials compatible with the public login DTO: %#', async (password) => {
		expect(acceptsBootstrapPassword(Buffer.from(password), 'owner@example.com')).toBe(true);
		const input = plainToInstance(PlatformLoginDto, { email: 'owner@example.com', password });
		expect(await validate(input)).toEqual([]);
		expect(input.password).toBe(password);
	});

	it('preserves whitespace and Unicode bytes through the approved Argon2id verifier', async () => {
		const config = new ConfigService<EnvironmentVariables, true>(
			validateEnvironment({ NODE_ENV: 'test' }),
		);
		const passwords = new PlatformPasswordService(config);
		const value = '  fictional é password  ';
		const input = Buffer.from(value);
		try {
			expect(acceptsBootstrapPassword(input, 'owner@example.com')).toBe(true);
			const hash = await passwords.hash(input);
			expect(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
			expect(await passwords.verify(hash, value)).toBe(true);
			expect(await passwords.verify(hash, value.trim())).toBe(false);
		} finally {
			input.fill(0);
		}
	});
});
