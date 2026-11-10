import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { PasswordHashingService } from '../../../common/identity/password-hashing.service.js';

/** Compatibility provider; all password decisions use the shared identity implementation. */
@Injectable()
export class PlatformPasswordService extends PasswordHashingService {
	constructor(config: ConfigService<EnvironmentVariables, true>) {
		super(config);
	}
}
