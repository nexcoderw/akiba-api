import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '@nexcoderw/akiba-db';

import {
	validateOwnerInvitationWorkerEnvironment,
	type OwnerInvitationWorkerEnvironment,
} from '../../../config/owner-invitation-worker.environment.js';
import { ResendOwnerInvitationEmailService } from '../../../infrastructure/email/resend-owner-invitation-email.service.js';
import { OwnerInvitationDeliveryGate } from './owner-invitation-delivery.policy.js';
import { OwnerInvitationDeliveryWorkerService } from './owner-invitation-delivery-worker.service.js';
import { OwnerInvitationTokenEnvelopeService } from './owner-invitation-token-envelope.service.js';
import { OwnerInvitationTokenService } from './owner-invitation-token.service.js';

/** Explicit worker context only. No HTTP controllers, authentication providers or auto-start hooks. */
@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			envFilePath: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local',
			ignoreEnvFile: process.env.NODE_ENV === 'test',
			cache: true,
			validate: validateOwnerInvitationWorkerEnvironment,
		}),
		DatabaseModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService<OwnerInvitationWorkerEnvironment, true>) => ({
				databaseUrl: config.get('DATABASE_URL', { infer: true }),
				poolMax: config.get('DATABASE_POOL_MAX', { infer: true }),
				connectionTimeoutMilliseconds: config.get('DATABASE_CONNECTION_TIMEOUT_MS', {
					infer: true,
				}),
			}),
		}),
	],
	providers: [
		OwnerInvitationDeliveryGate,
		OwnerInvitationDeliveryWorkerService,
		OwnerInvitationTokenService,
		OwnerInvitationTokenEnvelopeService,
		ResendOwnerInvitationEmailService,
	],
})
export class OwnerInvitationDeliveryWorkerModule {}
