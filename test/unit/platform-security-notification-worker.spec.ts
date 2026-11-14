import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { ResendEmailService } from '../../src/infrastructure/email/resend-email.service.js';
import { PlatformSecurityNotificationWorkerService } from '../../src/modules/platform/mfa/platform-security-notification-worker.service.js';

describe('durable platform security notification worker', () => {
	const findMany = jest.fn<() => Promise<unknown>>();
	const updateMany = jest.fn<(input: unknown) => Promise<{ count: number }>>();
	const send = jest.fn<() => Promise<string>>();
	let service: PlatformSecurityNotificationWorkerService;
	let module: TestingModule;
	beforeAll(async () => {
		module = await Test.createTestingModule({
			providers: [
				PlatformSecurityNotificationWorkerService,
				{
					provide: ConfigService,
					useValue: new ConfigService<EnvironmentVariables, true>(
						validateEnvironment({
							NODE_ENV: 'test',
							PLATFORM_MFA_MANAGEMENT_ENABLED: 'true',
							RESEND_API_KEY: 're_fictional',
							RESEND_FROM_EMAIL: 'security@example.com',
						}),
					),
				},
				{
					provide: PrismaService,
					useValue: { platformSecurityNotification: { findMany, updateMany } },
				},
				{ provide: ResendEmailService, useValue: { sendSecurityNotification: send } },
			],
		}).compile();
		service = module.get(PlatformSecurityNotificationWorkerService);
	});
	afterAll(async () => {
		await module.close();
	});
	beforeEach(() => {
		jest.clearAllMocks();
		findMany.mockResolvedValue([
			{ id: 'notification-id', recipient: 'owner@example.com', event: 'mfa_factor_replaced' },
		]);
		updateMany.mockResolvedValue({ count: 1 });
		send.mockResolvedValue('2f5298af-cf42-4e66-8968-a42be74cb34b');
	});
	it('reserves one row before delivery and records success afterward', async () => {
		await expect(service.runBatch()).resolves.toEqual({ sent: 1, uncertain: 0 });
		expect(updateMany.mock.calls[0]?.[0]).toEqual({
			where: { id: 'notification-id', status: 'queued' },
			data: { status: 'sending' },
		});
		expect(send).toHaveBeenCalledWith(
			'owner@example.com',
			'mfa_factor_replaced',
			'notification-id',
		);
		expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
			data: { status: 'sent', providerMessageId: '2f5298af-cf42-4e66-8968-a42be74cb34b' },
		});
	});
	it('does not send after another worker reserves the notification', async () => {
		updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(service.runBatch()).resolves.toEqual({ sent: 0, uncertain: 0 });
		expect(send).not.toHaveBeenCalled();
	});
	it('records uncertainty without retrying an unconfirmed provider submission', async () => {
		send.mockRejectedValueOnce(new Error('private provider details'));
		await expect(service.runBatch()).resolves.toEqual({ sent: 0, uncertain: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(updateMany.mock.calls[1]?.[0]).toEqual({
			where: { id: 'notification-id', status: 'sending' },
			data: { status: 'uncertain' },
		});
	});
	it('retains a confirmed provider identifier if recording completion fails', async () => {
		updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockRejectedValueOnce(new Error('synthetic write failure'));
		await expect(service.runBatch()).resolves.toEqual({ sent: 0, uncertain: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(updateMany.mock.calls[2]?.[0]).toMatchObject({
			data: {
				status: 'uncertain',
				providerMessageId: '2f5298af-cf42-4e66-8968-a42be74cb34b',
			},
		});
	});
});
