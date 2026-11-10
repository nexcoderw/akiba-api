import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import { AppModule } from '../../src/app.module.js';
import { PlatformAuthController } from '../../src/modules/platform/auth/platform-auth.controller.js';
import { PlatformLoginService } from '../../src/modules/platform/auth/platform-login.service.js';
import { PlatformMfaService } from '../../src/modules/platform/auth/platform-mfa.service.js';
import { PlatformPermissionGuard } from '../../src/modules/platform/auth/platform-permission.guard.js';
import { PlatformSessionGuard } from '../../src/modules/platform/auth/platform-session.guard.js';
import { PlatformSessionService } from '../../src/modules/platform/auth/platform-session.service.js';

describe('PlatformAuthModule integration', () => {
	let module: TestingModule;

	beforeAll(async () => {
		module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(PrismaService)
			.useValue({})
			.compile();
	});

	afterAll(async () => {
		await module.close();
	});

	it('registers focused authentication, session, and authorization providers', () => {
		expect(module.get(PlatformAuthController)).toBeInstanceOf(PlatformAuthController);
		expect(module.get(PlatformLoginService)).toBeInstanceOf(PlatformLoginService);
		expect(module.get(PlatformMfaService)).toBeInstanceOf(PlatformMfaService);
		expect(module.get(PlatformSessionService)).toBeInstanceOf(PlatformSessionService);
		expect(module.get(PlatformSessionGuard)).toBeInstanceOf(PlatformSessionGuard);
		expect(module.get(PlatformPermissionGuard)).toBeInstanceOf(PlatformPermissionGuard);
	});
});
