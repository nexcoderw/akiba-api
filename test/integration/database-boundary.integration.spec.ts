import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { validateEnvironment } from '../../src/config/environment.validation.js';
import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';

describe('offline database boundary', () => {
	it('refuses the real database module before creating a client in a test process', async () => {
		await expect(
			Test.createTestingModule({
				imports: [
					ConfigModule.forRoot({
						isGlobal: true,
						ignoreEnvFile: true,
						validate: () => validateEnvironment({ NODE_ENV: 'test' }),
					}),
					DatabaseIntegrationModule,
				],
			}).compile(),
		).rejects.toThrow('Offline tests must replace DatabaseIntegrationModule with a fake.');
	});
});
