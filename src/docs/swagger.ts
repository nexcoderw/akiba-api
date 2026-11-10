import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { API_VERSION } from '../common/constants/api.constants.js';
import { ApiErrorResponseDto } from '../common/dto/api-error-response.dto.js';
import { OWNER_SESSION_COOKIE } from '../modules/owner/auth/owner-auth.constants.js';
import { PLATFORM_SESSION_COOKIE } from '../modules/platform/auth/platform-auth.constants.js';

/** Builds the OpenAPI document used by protected Swagger UI and JSON export workflows. */
export function createOpenApiDocument(application: INestApplication): OpenAPIObject {
	const configuration = new DocumentBuilder()
		.setTitle('Akiba API')
		.setDescription(
			'Shared multi-tenant API for Akiba. Tenant access always requires authenticated organization authorization.',
		)
		.setVersion(API_VERSION)
		.addServer('/', 'API origin; operation paths include the configured prefix and version')
		.addCookieAuth(PLATFORM_SESSION_COOKIE, { type: 'apiKey', in: 'cookie' }, 'platform-session')
		.addCookieAuth(OWNER_SESSION_COOKIE, { type: 'apiKey', in: 'cookie' }, 'owner-session')
		.build();

	const document = SwaggerModule.createDocument(application, configuration, {
		extraModels: [ApiErrorResponseDto],
	});
	for (const item of Object.values(document.paths)) {
		for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const) {
			const operation = item[method];
			if (operation === undefined) continue;
			for (const [status, response] of Object.entries(operation.responses)) {
				if (response === undefined || Number(status) < 400 || '$ref' in response) continue;
				response.content = {
					'application/problem+json': {
						schema: { $ref: '#/components/schemas/ApiErrorResponseDto' },
					},
				};
				response.headers = {
					...response.headers,
					'X-Request-Id': {
						schema: { type: 'string' },
						description: 'Server-generated support correlation ID.',
					},
					'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
				};
			}
		}
	}
	return document;
}

export function configureSwagger(application: INestApplication): void {
	SwaggerModule.setup('docs', application, createOpenApiDocument(application), {
		customSiteTitle: 'Akiba API Documentation',
	});
}
