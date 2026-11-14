import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from '../../../config/environment.validation.js';
import { DatabaseIntegrationModule } from '../../../infrastructure/database/database-integration.module.js';
import { ResendEmailService } from '../../../infrastructure/email/resend-email.service.js';
import { PlatformSecurityNotificationWorkerService } from './platform-security-notification-worker.service.js';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			cache: true,
			envFilePath: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local',
			ignoreEnvFile: process.env.NODE_ENV === 'test',
			validate: validateEnvironment,
		}),
		DatabaseIntegrationModule,
	],
	providers: [ResendEmailService, PlatformSecurityNotificationWorkerService],
})
export class PlatformSecurityWorkerModule {}
