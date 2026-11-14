import { SetMetadata } from '@nestjs/common';

export const PLATFORM_CSRF_REQUIRED_METADATA = 'platform-auth:csrf-required';

/** Adds double-submit CSRF validation in addition to the mandatory exact Origin check. */
export const RequirePlatformCsrf = (): ClassDecorator & MethodDecorator =>
	SetMetadata(PLATFORM_CSRF_REQUIRED_METADATA, true);
