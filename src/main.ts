import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { configureApplication } from './app-bootstrap.js';
import { AppModule } from './app.module.js';
import { SanitizedLogger } from './common/logging/sanitized-logger.js';
import type { EnvironmentVariables } from './config/environment.types.js';

async function bootstrap(): Promise<void> {
	const logger = new SanitizedLogger();
	let application: NestExpressApplication | undefined;
	try {
		// DI/configuration errors must not be printed with raw secret-bearing stacks by Nest.
		application = await NestFactory.create<NestExpressApplication>(AppModule, {
			logger: false,
			abortOnError: false,
			bodyParser: false,
		});
		const config = application.get(ConfigService<EnvironmentVariables, true>);
		application.useLogger(logger);
		configureApplication(application, {
			CORS_ORIGINS: config.get('CORS_ORIGINS', { infer: true }),
			SWAGGER_ENABLED: config.get('SWAGGER_ENABLED', { infer: true }),
			BODY_LIMIT_BYTES: config.get('BODY_LIMIT_BYTES', { infer: true }),
			TRUST_PROXY_CIDRS: config.get('TRUST_PROXY_CIDRS', { infer: true }),
		});
		await application.listen(
			config.get('PORT', { infer: true }),
			config.get('HOST', { infer: true }),
		);
	} catch {
		logger.error({ event: 'startup.failed' });
		try {
			await application?.close();
		} catch {
			logger.error({ event: 'shutdown.failed' });
		}
		process.exitCode = 1;
	}
}

void bootstrap();
