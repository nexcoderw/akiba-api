import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.types.js';

/** Narrow transactional adapter. Never return or log provider payloads, recipients or codes. */
@Injectable()
export class ResendEmailService {
	constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

	async sendOtp(recipient: string, code: string, deliveryId: string): Promise<void> {
		const key = this.config.get('RESEND_API_KEY', { infer: true });
		const from = this.config.get('RESEND_FROM_EMAIL', { infer: true });
		if (key === null || from === null) throw unavailable();
		try {
			const response = await fetch('https://api.resend.com/emails', {
				method: 'POST',
				redirect: 'error',
				signal: AbortSignal.timeout(8_000),
				headers: {
					Authorization: `Bearer ${key}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': `platform-otp/${deliveryId}`,
				},
				body: JSON.stringify({
					from,
					to: [recipient],
					subject: 'Your Akiba verification code',
					text: `Your sign-in code is ${code}. It expires within five minutes. Use only the newest code. Do not share it. If you did not request this, ignore this email.`,
				}),
			});
			if (
				!response.ok ||
				response.body === null ||
				!response.headers.get('content-type')?.includes('application/json')
			) {
				await response.body?.cancel();
				throw unavailable();
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				let chunk = await reader.read();
				while (!chunk.done) {
					size += chunk.value.byteLength;
					if (size > 4_096) throw unavailable();
					chunks.push(chunk.value);
					chunk = await reader.read();
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
			const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (
				typeof data !== 'object' ||
				data === null ||
				!('id' in data) ||
				typeof data.id !== 'string' ||
				!/^[0-9a-f-]{36}$/iu.test(data.id)
			)
				throw unavailable();
		} catch {
			// A timeout is an uncertain delivery, not permission for a blind resend.
			throw unavailable();
		}
	}
}

function unavailable(): ServiceUnavailableException {
	return new ServiceUnavailableException({
		code: 'PLATFORM_EMAIL_UNAVAILABLE',
		message: 'Email verification is temporarily unavailable.',
	});
}
