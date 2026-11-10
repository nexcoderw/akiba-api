import { Module } from '@nestjs/common';

import { OwnerAuthModule } from './auth/owner-auth.module.js';
import { OwnerEnrollmentModule } from './enrollment/owner-enrollment.module.js';
import { OwnerPortalModule } from './portal/owner-portal.module.js';

@Module({ imports: [OwnerAuthModule, OwnerEnrollmentModule, OwnerPortalModule] })
export class OwnerModule {}
