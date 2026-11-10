import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { DatabaseIntegrationModule } from '../../src/infrastructure/database/database-integration.module.js';
import { OfflineDatabaseModule } from '../fixtures/offline-database.module.js';
import { PlatformBootstrapCliModule } from '../../src/modules/platform/bootstrap/platform-bootstrap-cli.module.js';
import { PlatformOwnerBootstrapService } from '../../src/modules/platform/bootstrap/platform-owner-bootstrap.service.js';

describe('PlatformBootstrapCliModule integration', () => {
	let module: TestingModule;

	beforeAll(async () => {
		module = await Test.createTestingModule({ imports: [PlatformBootstrapCliModule] })
			.overrideModule(DatabaseIntegrationModule)
			.useModule(OfflineDatabaseModule)
			.overrideProvider(PrismaService)
			.useValue({})
			.compile();
	});

	afterAll(async () => {
		await module.close();
	});

	it('registers a standalone bootstrap service without an HTTP controller', () => {
		const service = module.get(PlatformOwnerBootstrapService);

		expect(service).toBeInstanceOf(PlatformOwnerBootstrapService);
		expect(() => service.getTarget()).toThrow('Platform owner bootstrap is disabled');
	});
});
