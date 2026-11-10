import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../../config/environment.types.js';
import { isOrganizationPortalOrigin } from '../../config/organization-portal-origin.js';
import type { InvitationEmailSnapshot } from '../../modules/platform/owner-onboarding/owner-invitation-token-envelope.service.js';

export type InvitationProviderOutcome =
	| { readonly kind: 'accepted'; readonly messageId: string }
	| {
			readonly kind: 'failed';
			readonly code:
				'PROVIDER_RATE_LIMITED' | 'PROVIDER_REJECTED' | 'DELIVERY_CONFIGURATION_CHANGED';
			readonly retryable: boolean;
	  }
	| {
			readonly kind: 'uncertain';
			readonly code: 'PROVIDER_OUTCOME_UNKNOWN' | 'PROVIDER_RESPONSE_INVALID';
	  };

@Injectable()
export class ResendOwnerInvitationEmailService {
	constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

	/** No internal retries. Every attempt uses the reservation's exact payload and key. */
	async send(
		snapshot: InvitationEmailSnapshot,
		idempotencyKey: string,
		expiresAt: Date,
	): Promise<InvitationProviderOutcome> {
		const settings = this.config.get('OWNER_INVITATION_DELIVERY', { infer: true });
		const key = this.config.get('RESEND_API_KEY', { infer: true });
		const sender = this.config.get('RESEND_FROM_EMAIL', { infer: true });
		if (
			settings === null ||
			key === null ||
			sender === null ||
			snapshot.sender !== sender ||
			!isOrganizationPortalOrigin(snapshot.acceptanceOrigin, settings.portalOriginPolicy) ||
			snapshot.acceptancePath !== settings.acceptancePath ||
			!/^owner-invitation-delivery:[0-9a-f-]{36}$/u.test(idempotencyKey)
		) {
			return { kind: 'failed', code: 'DELIVERY_CONFIGURATION_CHANGED', retryable: false };
		}
		const link = new URL(snapshot.acceptancePath, snapshot.acceptanceOrigin);
		link.hash = `token=${snapshot.token}`;
		const text = `You are invited to manage ${snapshot.organizationName} on Akiba.\n\nReview your invitation: ${link.toString()}\n\nThis invitation expires at ${expiresAt.toISOString()} (UTC). It does not create or activate an account. No account credentials are included. If you did not expect this invitation, ignore it.`;
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
					from: sender,
					to: [snapshot.recipient],
					subject: "You're invited to manage a organization on Akiba",
					text,
					html: `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`,
				}),
			});
			if (!response.ok) {
				await response.body?.cancel();
				if (response.status === 429)
					return { kind: 'failed', code: 'PROVIDER_RATE_LIMITED', retryable: true };
				if ([400, 401, 403, 404, 422].includes(response.status)) {
					return { kind: 'failed', code: 'PROVIDER_REJECTED', retryable: false };
				}
				return { kind: 'uncertain', code: 'PROVIDER_OUTCOME_UNKNOWN' };
			}
			const value = await boundedJson(response);
			if (
				typeof value !== 'object' ||
				value === null ||
				!('id' in value) ||
				typeof value.id !== 'string' ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
					value.id,
				)
			) {
				return { kind: 'uncertain', code: 'PROVIDER_RESPONSE_INVALID' };
			}
			return { kind: 'accepted', messageId: value.id };
		} catch {
			// A transport exception cannot establish whether submission happened. Never retry it here.
			return { kind: 'uncertain', code: 'PROVIDER_OUTCOME_UNKNOWN' };
		}
	}
}

async function boundedJson(response: Response): Promise<unknown> {
	if (
		response.body === null ||
		!response.headers.get('content-type')?.includes('application/json')
	) {
		await response.body?.cancel();
		return null;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		let chunk = await reader.read();
		while (!chunk.done) {
			size += chunk.value.byteLength;
			if (size > 4096) return null;
			chunks.push(chunk.value);
			chunk = await reader.read();
		}
		const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return data;
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
