import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { AppModule } from '../../src/app.module.js';
import { OwnerSessionGuard } from '../../src/modules/owner/auth/owner-session.guard.js';
import { OwnerAcceptanceService } from '../../src/modules/owner/enrollment/owner-acceptance.service.js';
import { OwnerEnrollmentController } from '../../src/modules/owner/enrollment/owner-enrollment.controller.js';
import { OwnerEnrollmentSessionGuard } from '../../src/modules/owner/enrollment/owner-enrollment-session.guard.js';

describe('OwnerEnrollmentModule integration', () => {
	let module: TestingModule;

	beforeAll(async () => {
		module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue({})
			.compile();
	});

	afterAll(async () => module.close());

	it('registers the acceptance-only session guard without replacing tenant authorization', () => {
		expect(module.get(OwnerEnrollmentController)).toBeInstanceOf(OwnerEnrollmentController);
		expect(module.get(OwnerAcceptanceService)).toBeInstanceOf(OwnerAcceptanceService);
		expect(module.get(OwnerEnrollmentSessionGuard)).toBeInstanceOf(OwnerEnrollmentSessionGuard);
		expect(module.get(OwnerSessionGuard)).toBeInstanceOf(OwnerSessionGuard);
	});
});
