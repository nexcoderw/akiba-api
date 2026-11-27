import 'reflect-metadata';

import { setTimeout as delay } from 'node:timers/promises';

import { Logger, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '@nexcoderw/akiba-db';

import { OwnerInvitationDeliveryWorkerModule } from '../modules/platform/owner-onboarding/owner-invitation-delivery-worker.module.js';
import { OwnerInvitationDeliveryGate } from '../modules/platform/owner-onboarding/owner-invitation-delivery.policy.js';
import { OwnerInvitationDeliveryWorkerService } from '../modules/platform/owner-onboarding/owner-invitation-delivery-worker.service.js';

const safeCodes = new Set([
	'OWNER_INVITATION_WORKER_OPERATION_FAILED',
	'OWNER_INVITATION_DELIVERY_UNCERTAIN',
	'OWNER_INVITATION_WORKER_STOPPED',
]);

/** Nest bootstrap exceptions can include driver details; log only reviewed worker metadata. */
function operationalEvent(value: unknown): boolean {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('code' in value) ||
		typeof value.code !== 'string' ||
		!safeCodes.has(value.code)
	)
		return false;
	const event: Record<string, string> = { code: value.code };
	for (const name of ['workerId', 'deliveryId', 'organizationId']) {
		if (name in value) {
			const property: unknown = Reflect.get(value, name);
			if (typeof property === 'string' && /^[A-Za-z0-9._:-]{1,120}$/u.test(property))
				event[name] = property;
		}
	}
	process.stderr.write(`${JSON.stringify(event)}\n`);
	return true;
}

const operationalLogger: LoggerService = {
	log(value: unknown): void {
		operationalEvent(value);
	},
	warn(value: unknown): void {
		operationalEvent(value);
	},
	error(value: unknown): void {
		if (!operationalEvent(value))
			process.stderr.write('{"code":"OWNER_INVITATION_WORKER_RUNTIME_ERROR"}\n');
	},
};

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const checkOnly = args.length === 1 && args[0] === '--check';
	if (args.length > 0 && !checkOnly) throw new Error('Unsupported worker arguments.');
	const workerId = checkOnly ? 'queue-check' : process.env.OWNER_INVITATION_WORKER_ID;
	if (workerId === undefined || !/^[A-Za-z0-9._:-]{1,120}$/u.test(workerId)) {
		throw new Error('Missing stable worker identity.');
	}
	const application = await NestFactory.createApplicationContext(
		OwnerInvitationDeliveryWorkerModule,
		{ logger: operationalLogger, abortOnError: false },
	);
	const shutdown = new AbortController();
	const stop = (): void => {
		shutdown.abort();
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	try {
		const gate = application.get(OwnerInvitationDeliveryGate);
		await gate.assertDatabase();
		if (checkOnly) {
			const prisma = application.get(PrismaService);
			const queue = await prisma.$queryRaw<
				{ status: string; total: string; expiredQueued: string }[]
			>`
				SELECT status::text AS status, count(*)::text AS total,
					count(*) FILTER (WHERE status = 'queued' AND token_expires_at <= now())::text
						AS "expiredQueued"
				FROM public.organization_owner_invitation_deliveries
				GROUP BY status ORDER BY status
			`;
			process.stdout.write(
				`${JSON.stringify({ code: 'OWNER_INVITATION_QUEUE_CHECKED', queue })}\n`,
			);
			return;
		}
		const worker = application.get(OwnerInvitationDeliveryWorkerService);
		while (!shutdown.signal.aborted) {
			await worker.runOnce(workerId);
			try {
				await delay(1000, undefined, { signal: shutdown.signal });
			} catch (error: unknown) {
				if (error instanceof Error && error.name === 'AbortError') continue;
				throw new Error('Worker scheduling failed.', { cause: error });
			}
		}
	} finally {
		// Finish the bounded current batch; never return in-flight submissions to QUEUED.
		process.removeListener('SIGINT', stop);
		process.removeListener('SIGTERM', stop);
		await application.close();
	}
}

void main().catch(() => {
	new Logger('OwnerInvitationDeliveryWorker').error({
		code: 'OWNER_INVITATION_WORKER_STOPPED',
		message: 'Review protected configuration and database prerequisites before restarting.',
	});
	process.exitCode = 1;
});
