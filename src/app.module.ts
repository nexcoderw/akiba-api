import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import type { EnvironmentVariables } from './config/environment.types.js';
import { validateEnvironment } from './config/environment.validation.js';
import { DatabaseIntegrationModule } from './infrastructure/database/database-integration.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OwnerModule } from './modules/owner/owner.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';

@Module({
	imports: [
		ConfigModule.forRoot({
			cache: true,
			envFilePath: ['.env.local'],
			ignoreEnvFile: process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'production',
			isGlobal: true,
			validate: validateEnvironment,
		}),
		DatabaseIntegrationModule,
		ThrottlerModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
				throttlers: [
					{
						ttl: config.get('RATE_LIMIT_TTL_MS', { infer: true }),
						limit: config.get('RATE_LIMIT_LIMIT', { infer: true }),
					},
				],
			}),
		}),
		HealthModule,
		OwnerModule,
		PlatformModule,
	],
	providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
