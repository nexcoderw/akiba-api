export type PlatformMfaMethod = 'email_otp' | 'totp' | 'recovery_code';

/** Server-established platform identity attached only after full session validation. */
export interface PlatformPrincipal {
	readonly authenticationMethod?: string;
	readonly sessionId: string;
	readonly userId: string;
	readonly platformStaffId: string;
	readonly displayName: string;
	readonly email: string;
	readonly expiresAt: Date;
	readonly roles: readonly string[];
	readonly permissions: readonly string[];
}

export interface AcceptedTotp {
	readonly timeStep: bigint;
}
