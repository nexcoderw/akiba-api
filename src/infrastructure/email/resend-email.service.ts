import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.types.js';

/** Narrow transactional adapter. Never return or log provider payloads, recipients or codes. */
@Injectable()
export class ResendEmailService {
	constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

	/** Setup proof stays out of links, provider tags and diagnostics. */
	async sendOwnerEnrollment(recipient: string, token: string, deliveryId: string): Promise<void> {
		const origin = this.config.get('PLATFORM_ADMIN_ORIGIN', { infer: true });
		await this.send(
			recipient,
			'Set up your Akiba platform owner account',
			`Your operator authorized first-owner setup. Open ${origin}/enroll/platform-owner and enter this single-use setup code: ${token}\n\nIt expires in 15 minutes. Create your password and confirm an authenticator to complete setup. Do not share this code. If you did not expect this message, contact your operator.`,
			`platform-owner-enrollment/${deliveryId}`,
		);
	}

	async sendOtp(recipient: string, code: string, deliveryId: string): Promise<void> {
		await this.send(
			recipient,
			'Your Akiba verification code',
			`Your sign-in code is ${code}. It expires within five minutes. Use only the newest code. Do not share it. If you did not request this, ignore this email.`,
			`platform-otp/${deliveryId}`,
		);
	}

	async sendSecurityNotification(
		recipient: string,
		event: string,
		deliveryId: string,
	): Promise<string> {
		const labels: Readonly<Record<string, string>> = {
			mfa_factor_enrolled: 'An authenticator was enrolled.',
			mfa_factor_replaced: 'Your authenticator was replaced and prior sessions were invalidated.',
			mfa_factor_renamed: 'Your authenticator label was changed.',
			mfa_recovery_rotated:
				'Your recovery codes were replaced and prior sessions were invalidated.',
			mfa_recovery_used: 'A recovery code was used for platform authentication or MFA repair.',
		};
		const message = labels[event];
		if (message === undefined) throw unavailable();
		return this.send(
			recipient,
			'Akiba platform security change',
			`${message} If you did not authorize this change, contact your approved security operator immediately. This message contains no sign-in or recovery credentials.`,
			`platform-security/${deliveryId}`,
		);
	}

	private async send(
		recipient: string,
		subject: string,
		text: string,
		idempotencyKey: string,
	): Promise<string> {
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
					'Idempotency-Key': idempotencyKey,
				},
				body: JSON.stringify({
					from,
					to: [recipient],
					subject,
					text,
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
			return data.id;
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
