import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';

import { API_PREFIX, API_VERSION } from './common/constants/api.constants.js';
import { ApiExceptionFilter } from './common/filters/api-exception.filter.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { RequestLoggingMiddleware } from './common/middleware/request-logging.middleware.js';
import { createValidationException } from './common/pipes/validation-exception.factory.js';
import type { EnvironmentVariables } from './config/environment.types.js';
import { configureSwagger } from './docs/swagger.js';

type ApplicationConfiguration = Pick<EnvironmentVariables, 'CORS_ORIGINS' | 'SWAGGER_ENABLED'> &
	Partial<
		Pick<
			EnvironmentVariables,
			| 'ORGANIZATION_PORTAL_ORIGIN'
			| 'ORGANIZATION_PORTAL_BASE_DOMAIN'
			| 'BODY_LIMIT_BYTES'
			| 'TRUST_PROXY_CIDRS'
		>
	>;

/** Configure before init/listen: correlation and observation must precede parsers and guards. */
export function configureApplication(
	application: NestExpressApplication,
	configuration: ApplicationConfiguration,
): void {
	application.enableShutdownHooks();
	application.disable('x-powered-by');
	application.set(
		'trust proxy',
		configuration.TRUST_PROXY_CIDRS?.length ? [...configuration.TRUST_PROXY_CIDRS] : false,
	);
	const ids = new RequestIdMiddleware();
	const logs = new RequestLoggingMiddleware();
	application.use(ids.use.bind(ids));
	application.use(logs.use.bind(logs));
	application.use(helmet());
	const limit = configuration.BODY_LIMIT_BYTES ?? 32_768;
	application.use(json({ limit, strict: true }));
	application.use(urlencoded({ limit, extended: false, parameterLimit: 100 }));
	application.setGlobalPrefix(API_PREFIX);
	application.enableVersioning({ defaultVersion: API_VERSION, type: VersioningType.URI });
	const exactOrigins = new Set(configuration.CORS_ORIGINS);
	application.enableCors({
		origin(origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) {
			callback(null, origin === undefined || exactOrigins.has(origin));
		},
		credentials: true,
		exposedHeaders: ['X-Request-Id', 'Retry-After'],
		methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	});
	application.useGlobalFilters(new ApiExceptionFilter());
	application.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			forbidUnknownValues: true,
			transform: true,
			transformOptions: { enableImplicitConversion: false },
			validationError: { target: false, value: false },
			exceptionFactory: createValidationException,
		}),
	);
	if (configuration.SWAGGER_ENABLED) configureSwagger(application);
}
