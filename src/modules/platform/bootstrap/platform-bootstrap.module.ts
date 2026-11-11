import { Module } from '@nestjs/common';

import { PlatformOwnerBootstrapService } from './platform-owner-bootstrap.service.js';

@Module({
	providers: [PlatformOwnerBootstrapService],
	exports: [PlatformOwnerBootstrapService],
})
export class PlatformBootstrapModule {}
