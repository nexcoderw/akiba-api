import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../config/environment.types.js';

/** Registers the published database package once and exposes its public services application-wide. */
@Global()
@Module({
	imports: [
		DatabaseModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
				return {
					databaseUrl: config.get('DATABASE_URL', { infer: true }),
					poolMax: config.get('DATABASE_POOL_MAX', { infer: true }),
					connectionTimeoutMilliseconds: config.get('DATABASE_CONNECTION_TIMEOUT_MS', {
						infer: true,
					}),
				};
			},
		}),
	],
	exports: [DatabaseModule],
})
export class DatabaseIntegrationModule {}
