import { jest } from '@jest/globals';
import {
	Body,
	Controller,
	ForbiddenException,
	Get,
	Logger,
	Post,
	ServiceUnavailableException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	IsArray,
	IsEmail,
	IsString,
	MaxLength,
	MinLength,
	ValidateNested,
} from 'class-validator';
import request from 'supertest';

import { configureApplication } from '../../src/app-bootstrap.js';

class ContactDto {
	@IsEmail()
	@MaxLength(254)
	email!: string;
}
class ProbeDto {
	@IsString()
	@MinLength(12)
	@MaxLength(128)
	password!: string;

	@IsArray()
	@ArrayMaxSize(3)
	@ValidateNested({ each: true })
	@Type(() => ContactDto)
	contacts!: ContactDto[];
}

/** HTTP probes exist only in this offline test module, never in AppModule. */
@Controller('probe')
class ProbeController {
	@Post('validate')
	validate(@Body() input: ProbeDto): { contacts: number } {
		return { contacts: input.contacts.length };
	}

	@Get('explode/:id')
	explode(): never {
		throw new Error('postgresql://user:private-password@internal-host/private-table');
	}

	@Get('denied')
	denied(): never {
		throw new ForbiddenException({ code: 'ACCESS_DENIED', message: 'private-password' });
	}

	@Get('outage')
	outage(): never {
		throw new ServiceUnavailableException('private-password');
	}

	@Get('limited')
	@Throttle({ default: { limit: 1, ttl: 60_000 } })
	limited(): { status: string } {
		return { status: 'ok' };
	}
}

describe('Problem Details HTTP boundary (offline)', () => {
	let application: NestExpressApplication;
	const access = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
	const failures = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10_000 }])],
			controllers: [ProbeController],
			providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
		}).compile();
		application = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
		configureApplication(application, {
			CORS_ORIGINS: ['http://localhost:4000'],
			SWAGGER_ENABLED: false,
			BODY_LIMIT_BYTES: 1024,
		});
		await application.init();
	});
	afterAll(async () => {
		await application.close();
		access.mockRestore();
		failures.mockRestore();
	});

	it.each([
		{},
		{ password: 123, contacts: [{ email: 'valid@example.com' }] },
		{ password: 'private-password', contacts: [{ email: 'private-invalid-email' }] },
		{ password: 'private-password', contacts: [], privilege: 'platform.owner' },
	])('rejects invalid DTO input without exposing it', async (input) => {
		const response = await request(application.getHttpServer())
			.post('/api/v1/probe/validate')
			.send(input)
			.expect(400);
		expect(response.get('Content-Type')).toContain('application/problem+json');
		expect(response.get('Cache-Control')).toBe('no-store');
		expect(response.body).toMatchObject({
			status: 400,
			code: 'VALIDATION_FAILED',
			requestId: response.get('X-Request-Id'),
		});
		expect(JSON.stringify(response.body)).not.toMatch(
			/private-password|private-invalid-email|platform\.owner/u,
		);
	});

	it('exposes stable nested field errors', async () => {
		const response = await request(application.getHttpServer())
			.post('/api/v1/probe/validate')
			.send({ password: 'private-password', contacts: [{ email: 'invalid' }] })
			.expect(400);
		expect(response.body).toMatchObject({
			errors: [
				{
					field: 'contacts.0.email',
					code: 'INVALID_EMAIL',
					message: 'Enter a valid email address.',
				},
			],
		});
	});

	it('returns a safe correlated response for malformed JSON before controller/guard execution', async () => {
		const response = await request(application.getHttpServer())
			.post('/api/v1/probe/validate')
			.set('Content-Type', 'application/json')
			.set('X-Request-Id', 'client-forged-id')
			.send('{"password":"private-password"')
			.expect(400);
		expect(response.body).toMatchObject({
			code: 'BAD_REQUEST',
			requestId: response.get('X-Request-Id'),
		});
		expect(response.get('X-Request-Id')).not.toBe('client-forged-id');
		expect(JSON.stringify(response.body)).not.toContain('private-password');
	});

	it('rejects oversized requests with the same contract', async () => {
		const response = await request(application.getHttpServer())
			.post('/api/v1/probe/validate')
			.send({ password: 'private-password'.repeat(200) })
			.expect(413);
		expect(response.body).toMatchObject({
			status: 413,
			code: 'PAYLOAD_TOO_LARGE',
			requestId: response.get('X-Request-Id'),
		});
	});

	it('does not echo unknown paths or query tokens and issues a distinct server ID each time', async () => {
		const first = await request(application.getHttpServer())
			.get('/api/v1/private-path-token?token=private-query-token')
			.set('X-Request-Id', 'repeat-id')
			.expect(404);
		const second = await request(application.getHttpServer())
			.get('/api/v1/private-path-token')
			.set('X-Request-Id', 'repeat-id')
			.expect(404);
		expect(first.get('X-Request-Id')).not.toBe(second.get('X-Request-Id'));
		expect(JSON.stringify(first.body)).not.toMatch(/private-path-token|private-query-token/u);
	});

	it.each([
		['explode/private-path-token?token=private-query-token', 500, 'INTERNAL_ERROR'],
		['denied', 403, 'ACCESS_DENIED'],
		['outage', 503, 'SERVICE_UNAVAILABLE'],
	] as const)('sanitizes %s failures and operational logs', async (path, status, code) => {
		const response = await request(application.getHttpServer())
			.get(`/api/v1/probe/${path}`)
			.expect(status);
		expect(response.body).toMatchObject({ status, code });
		expect(JSON.stringify(response.body)).not.toMatch(
			/private-password|internal-host|private-table|private-path-token|private-query-token/u,
		);
		expect(JSON.stringify([...access.mock.calls, ...failures.mock.calls])).not.toMatch(
			/private-password|internal-host|private-table|private-path-token|private-query-token/u,
		);
	});

	it('preserves throttling status, Retry-After and the problem media type', async () => {
		await request(application.getHttpServer()).get('/api/v1/probe/limited').expect(200);
		const response = await request(application.getHttpServer())
			.get('/api/v1/probe/limited')
			.expect(429);
		expect(response.body).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
		expect(response.get('Retry-After')).toMatch(/^[0-9]+$/u);
	});

	it('allows only exact credentialed origins and disables the framework signature', async () => {
		const accepted = await request(application.getHttpServer())
			.get('/api/v1/probe/outage')
			.set('Origin', 'http://localhost:4000')
			.expect(503);
		expect(accepted.get('Access-Control-Allow-Origin')).toBe('http://localhost:4000');
		const denied = await request(application.getHttpServer())
			.get('/api/v1/probe/outage')
			.set('Origin', 'https://attacker.example.com')
			.set('X-Forwarded-For', '1.2.3.4')
			.expect(503);
		expect(denied.get('Access-Control-Allow-Origin')).toBeUndefined();
		expect(denied.get('x-powered-by')).toBeUndefined();
	});
});
