import { Module } from '@nestjs/common';

import { PlatformOwnerBootstrapService } from './platform-owner-bootstrap.service.js';
import { PlatformAuthModule } from '../auth/platform-auth.module.js';
import { PlatformOwnerEnrollmentService } from './platform-owner-enrollment.service.js';
import { PlatformOwnerEnrollmentController } from './platform-owner-enrollment.controller.js';

@Module({
	imports: [PlatformAuthModule],
	controllers: [PlatformOwnerEnrollmentController],
	providers: [PlatformOwnerBootstrapService, PlatformOwnerEnrollmentService],
	exports: [PlatformOwnerBootstrapService, PlatformOwnerEnrollmentService],
})
export class PlatformBootstrapModule {}
