import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PLATFORM_PERMISSION } from '../../src/modules/platform/auth/platform-permission.constants.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { createPlatformDashboardDatabaseFixture } from './platform-dashboard-database.fixture.js';
import { organizationSessionFixture } from './platform-organizations-database.fixture.js';

export const PLATFORM_SERVICE_AUTH_DATABASE = Symbol('platform-service-auth-database');

/** Real session authorization over a separate offline adapter, never a permissive policy mock. */
@Module({
	providers: [
		{
			provide: PLATFORM_SERVICE_AUTH_DATABASE,
			useFactory: () => {
				const database = createPlatformDashboardDatabaseFixture();
				database.sessionFindUnique.mockResolvedValue(
					organizationSessionFixture(Object.values(PLATFORM_PERMISSION)),
				);
				return database;
			},
		},
		{
			provide: PrismaService,
			inject: [PLATFORM_SERVICE_AUTH_DATABASE],
			useFactory: (database: ReturnType<typeof createPlatformDashboardDatabaseFixture>) =>
				database.prisma,
		},
		{
			provide: ConfigService,
			useFactory: () =>
				new ConfigService<EnvironmentVariables, true>(validateEnvironment({ NODE_ENV: 'test' })),
		},
		PlatformTokenService,
		PlatformSessionService,
	],
	exports: [PlatformSessionService, PLATFORM_SERVICE_AUTH_DATABASE],
})
export class PlatformServiceAuthModule {}
