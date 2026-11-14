import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { PlatformSecurityNotificationWorkerService } from '../modules/platform/mfa/platform-security-notification-worker.service.js';

async function run(): Promise<void> {
	if (!['development', 'production'].includes(process.env.NODE_ENV ?? ''))
		throw new Error('Select an explicit development or production environment.');
	const { PlatformSecurityWorkerModule } =
		await import('../modules/platform/mfa/platform-security-worker.module.js');
	const app = await NestFactory.createApplicationContext(PlatformSecurityWorkerModule, {
		logger: false,
		abortOnError: false,
	});
	try {
		const result = await app.get(PlatformSecurityNotificationWorkerService).runBatch();
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (result.uncertain > 0) process.exitCode = 1;
	} finally {
		await app.close();
	}
}

void run().catch(() => {
	process.stderr.write('SECURITY_NOTIFICATIONS_UNAVAILABLE: Review protected worker state.\n');
	process.exitCode = 1;
});
