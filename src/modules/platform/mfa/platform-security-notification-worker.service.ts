import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nexcoderw/akiba-db';

import { ApiProblemException } from '../../../common/errors/api-problem.exception.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { ResendEmailService } from '../../../infrastructure/email/resend-email.service.js';

/** Explicit operator worker. Uncertain sends require review and never trigger a blind retry. */
@Injectable()
export class PlatformSecurityNotificationWorkerService {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly email: ResendEmailService,
	) {}

	async runBatch(): Promise<{ sent: number; uncertain: number }> {
		if (!this.config.get('PLATFORM_MFA_MANAGEMENT_ENABLED', { infer: true }))
			throw new ApiProblemException('SERVICE_UNAVAILABLE');
		const rows = await this.prisma.platformSecurityNotification.findMany({
			where: { status: 'queued' },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			take: 20,
		});
		let sent = 0;
		let uncertain = 0;
		for (const row of rows) {
			const reserved = await this.prisma.platformSecurityNotification.updateMany({
				where: { id: row.id, status: 'queued' },
				data: { status: 'sending' },
			});
			if (reserved.count !== 1) continue;
			let providerMessageId: string | undefined;
			try {
				providerMessageId = await this.email.sendSecurityNotification(
					row.recipient,
					row.event,
					row.id,
				);
				const recorded = await this.prisma.platformSecurityNotification.updateMany({
					where: { id: row.id, status: 'sending' },
					data: { status: 'sent', sentAt: new Date(), providerMessageId },
				});
				if (recorded.count !== 1) throw new Error('Notification completion could not be recorded.');
				sent += 1;
			} catch {
				await this.prisma.platformSecurityNotification.updateMany({
					where: { id: row.id, status: 'sending' },
					data: {
						status: 'uncertain',
						...(providerMessageId === undefined ? {} : { providerMessageId }),
					},
				});
				uncertain += 1;
			}
		}
		return { sent, uncertain };
	}
}
