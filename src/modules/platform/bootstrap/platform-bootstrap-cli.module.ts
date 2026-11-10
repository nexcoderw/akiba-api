import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from '../../../config/environment.validation.js';
import { DatabaseIntegrationModule } from '../../../infrastructure/database/database-integration.module.js';
import { PlatformBootstrapModule } from './platform-bootstrap.module.js';

/** Standalone dependency graph for the operator CLI; it never creates an HTTP listener. */
@Module({
	imports: [
		ConfigModule.forRoot({
			cache: true,
			envFilePath: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local',
			ignoreEnvFile: process.env.NODE_ENV === 'test',
			isGlobal: true,
			validate: validateEnvironment,
		}),
		DatabaseIntegrationModule,
		PlatformBootstrapModule,
	],
})
export class PlatformBootstrapCliModule {}
