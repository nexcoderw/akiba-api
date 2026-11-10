import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import { PlatformStaffStatus, Prisma, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { PlatformPasswordService } from '../auth/platform-password.service.js';
import { acceptsBootstrapPassword } from '../auth/platform-password-policy.js';
import { PlatformTokenService } from '../auth/platform-token.service.js';
import { PlatformTotpService } from '../auth/platform-totp.service.js';
import {
	PLATFORM_OWNER_PERMISSIONS,
	PLATFORM_OWNER_RECOVERY_CODE_BYTES,
	PLATFORM_OWNER_RECOVERY_CODE_COUNT,
	PLATFORM_OWNER_ROLE,
} from './platform-bootstrap.constants.js';
import { acquireBootstrapLock, verifyBootstrapDatabase } from './platform-bootstrap-database.js';
import {
	PlatformBootstrapError,
	type ActivatePlatformOwnerInput,
	type InitializePlatformOwnerInput,
	type PlatformBootstrapTarget,
	type PlatformOwnerActivation,
	type PlatformOwnerEnrollment,
} from './platform-bootstrap.types.js';

const MINIMUM_DISPLAY_NAME_LENGTH = 2;
const MAXIMUM_DISPLAY_NAME_LENGTH = 160;
const TRANSACTION_TIMEOUT_MILLISECONDS = 15_000;

@Injectable()
export class PlatformOwnerBootstrapService {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
		private readonly passwords: PlatformPasswordService,
		private readonly tokens: PlatformTokenService,
		private readonly totp: PlatformTotpService,
	) {}

	getTarget(): PlatformBootstrapTarget {
		this.assertEnabled();
		const databaseHost = this.config.get('PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_HOST', {
			infer: true,
		});
		const databaseName = this.config.get('PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_NAME', {
			infer: true,
		});
		if (databaseHost === null || databaseName === null) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_DISABLED',
				'The approved bootstrap database target is unavailable.',
			);
		}
		return {
			environment: this.config.get('NODE_ENV', { infer: true }),
			databaseHost,
			databaseName,
		};
	}

	async initialize(input: InitializePlatformOwnerInput): Promise<PlatformOwnerEnrollment> {
		this.assertEnabled();
		const email = normalizeEmail(input.email);

		let passwordHash: string;
		let displayName: string;
		try {
			validateEmail(email);
			displayName = validateDisplayName(input.displayName);
			validatePassword(input.password, email);
			passwordHash = await this.passwords.hash(input.password);
		} finally {
			input.password.fill(0);
		}

		try {
			return await this.prisma.$transaction(
				async (transaction): Promise<PlatformOwnerEnrollment> => {
					await acquireBootstrapLock(transaction);
					await this.verifyDatabase(transaction);
					if ((await transaction.platformStaff.count()) !== 0) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_ALREADY_INITIALIZED',
							'A platform staff identity already exists; first-owner bootstrap is unavailable.',
						);
					}
					if (
						(await transaction.user.findUnique({
							where: { email },
							select: { id: true },
						})) !== null
					) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_IDENTITY_CONFLICT',
							'An identity already uses that email address; bootstrap will not modify it.',
						);
					}

					const roleId = await ensureOwnerRole(transaction);
					const identity = await transaction.user.create({
						data: {
							email,
							displayName,
							status: UserStatus.PENDING,
							passwordCredential: { create: { passwordHash } },
							platformStaff: { create: { status: PlatformStaffStatus.PENDING } },
						},
						select: { platformStaff: { select: { id: true } } },
					});
					if (identity.platformStaff === null) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_STATE_CONFLICT',
							'The pending platform staff identity was not created.',
						);
					}

					await transaction.platformStaffRole.create({
						data: { platformStaffId: identity.platformStaff.id, platformRoleId: roleId },
					});
					const enrollment = this.totp.createEnrollment(identity.platformStaff.id, email);
					await transaction.platformTotpCredential.create({
						data: {
							platformStaffId: identity.platformStaff.id,
							encryptedSecret: Buffer.from(enrollment.encryptedSecret),
							encryptionKeyId: enrollment.encryptionKeyId,
							encryptionVersion: enrollment.encryptionVersion,
							initializationVector: Buffer.from(enrollment.initializationVector),
							authenticationTag: Buffer.from(enrollment.authenticationTag),
						},
					});
					return { enrollmentUri: enrollment.enrollmentUri, secret: enrollment.secret };
				},
				transactionOptions,
			);
		} catch (error: unknown) {
			throw translateTransactionError(error);
		}
	}

	async activate(input: ActivatePlatformOwnerInput): Promise<PlatformOwnerActivation> {
		this.assertEnabled();
		const email = normalizeEmail(input.email);
		validateEmail(email);
		if (!/^\d{6}$/u.test(input.totpCode) || !input.emailOwnershipVerified) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_INVALID_INPUT',
				'A six-digit TOTP code and independent mailbox ownership verification are required.',
			);
		}

		try {
			return await this.prisma.$transaction(
				async (transaction): Promise<PlatformOwnerActivation> => {
					await acquireBootstrapLock(transaction);
					await this.verifyDatabase(transaction);
					if ((await transaction.platformStaff.count()) !== 1) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_STATE_CONFLICT',
							'Activation requires exactly one pending platform staff identity.',
						);
					}
					const identity = await transaction.user.findUnique({
						where: { email },
						select: {
							id: true,
							status: true,
							emailVerifiedAt: true,
							platformStaff: {
								select: {
									id: true,
									status: true,
									roles: {
										select: {
											platformRole: {
												select: {
													key: true,
													isSystem: true,
													permissions: {
														select: {
															platformPermission: { select: { key: true } },
														},
													},
												},
											},
										},
									},
									totpCredential: true,
								},
							},
						},
					});
					const staff = identity?.platformStaff;
					if (!staff) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_PENDING_OWNER_NOT_FOUND',
							'No pending first-owner enrollment matches the supplied identity.',
						);
					}
					if (
						identity.status !== UserStatus.PENDING ||
						staff.status !== PlatformStaffStatus.PENDING ||
						staff.totpCredential?.verifiedAt !== null ||
						staff.totpCredential.disabledAt !== null ||
						staff.totpCredential.lastAcceptedTimeStep !== null
					) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_STATE_CONFLICT',
							'The enrollment is not in the required pending state.',
						);
					}
					assertExactOwnerRole(staff.roles);

					const accepted = this.totp.verify(
						{
							platformStaffId: staff.id,
							encryptedSecret: staff.totpCredential.encryptedSecret,
							initializationVector: staff.totpCredential.initializationVector,
							authenticationTag: staff.totpCredential.authenticationTag,
							encryptionKeyId: staff.totpCredential.encryptionKeyId,
							encryptionVersion: staff.totpCredential.encryptionVersion,
						},
						input.totpCode,
						new Date(),
					);
					if (accepted === null) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_MFA_REJECTED',
							'The TOTP verification code was rejected.',
						);
					}

					const now = new Date();
					const recoveryCodes = createRecoveryCodes();
					const totpUpdated = await transaction.platformTotpCredential.updateMany({
						where: {
							id: staff.totpCredential.id,
							platformStaffId: staff.id,
							verifiedAt: null,
							disabledAt: null,
							lastAcceptedTimeStep: null,
						},
						data: {
							verifiedAt: now,
							lastUsedAt: now,
							lastAcceptedTimeStep: accepted.timeStep,
						},
					});
					const userUpdated = await transaction.user.updateMany({
						where: { id: identity.id, status: UserStatus.PENDING },
						data: {
							status: UserStatus.ACTIVE,
							emailVerifiedAt: identity.emailVerifiedAt ?? now,
						},
					});
					const staffUpdated = await transaction.platformStaff.updateMany({
						where: { id: staff.id, status: PlatformStaffStatus.PENDING },
						data: { status: PlatformStaffStatus.ACTIVE },
					});
					if (totpUpdated.count !== 1 || userUpdated.count !== 1 || staffUpdated.count !== 1) {
						throw new PlatformBootstrapError(
							'BOOTSTRAP_CONCURRENT_OPERATION',
							'The pending enrollment changed concurrently; no activation was completed.',
						);
					}
					await transaction.platformRecoveryCode.createMany({
						data: recoveryCodes.map((code) => ({
							platformStaffId: staff.id,
							codeDigest: this.tokens.digest(code),
						})),
					});
					return { recoveryCodes };
				},
				transactionOptions,
			);
		} catch (error: unknown) {
			throw translateTransactionError(error);
		}
	}

	private async verifyDatabase(transaction: Prisma.TransactionClient): Promise<void> {
		const target = this.getTarget();
		const databaseRole = this.config.get('PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_ROLE', {
			infer: true,
		});
		const databaseMarker = this.config.get('PLATFORM_OWNER_BOOTSTRAP_EXPECTED_DATABASE_MARKER', {
			infer: true,
		});
		if (databaseRole === null || databaseMarker === null) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_UNSAFE_DATABASE',
				'The approved database role and marker are required.',
			);
		}
		await verifyBootstrapDatabase(transaction, {
			databaseName: target.databaseName,
			databaseRole,
			databaseMarker,
		});
	}

	private assertEnabled(): void {
		if (!this.config.get('PLATFORM_OWNER_BOOTSTRAP_ENABLED', { infer: true })) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_DISABLED',
				'Platform owner bootstrap is disabled by configuration.',
			);
		}
	}
}

const transactionOptions = Object.freeze({
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: TRANSACTION_TIMEOUT_MILLISECONDS,
	timeout: TRANSACTION_TIMEOUT_MILLISECONDS,
});

async function ensureOwnerRole(transaction: Prisma.TransactionClient): Promise<string> {
	const existingRole = await transaction.platformRole.findUnique({
		where: { key: PLATFORM_OWNER_ROLE.key },
		select: {
			id: true,
			isSystem: true,
			permissions: {
				select: { platformPermission: { select: { key: true } } },
			},
		},
	});
	if (existingRole !== null) {
		if (!existingRole.isSystem) {
			throw roleConflict();
		}
		const approved = new Set<string>(PLATFORM_OWNER_PERMISSIONS.map(({ key }) => key));
		if (
			existingRole.permissions.some(
				({ platformPermission }) => !approved.has(platformPermission.key),
			)
		) {
			throw roleConflict();
		}
	}

	const role =
		existingRole ??
		(await transaction.platformRole.create({
			data: { ...PLATFORM_OWNER_ROLE, isSystem: true },
			select: { id: true },
		}));
	for (const descriptor of PLATFORM_OWNER_PERMISSIONS) {
		const permission =
			(await transaction.platformPermission.findUnique({
				where: { key: descriptor.key },
				select: { id: true },
			})) ??
			(await transaction.platformPermission.create({
				data: descriptor,
				select: { id: true },
			}));
		await transaction.platformRolePermission.upsert({
			where: {
				platformRoleId_platformPermissionId: {
					platformRoleId: role.id,
					platformPermissionId: permission.id,
				},
			},
			create: { platformRoleId: role.id, platformPermissionId: permission.id },
			update: {},
		});
	}
	return role.id;
}

function assertExactOwnerRole(
	roles: readonly {
		readonly platformRole: {
			readonly key: string;
			readonly isSystem: boolean;
			readonly permissions: readonly {
				readonly platformPermission: { readonly key: string };
			}[];
		};
	}[],
): void {
	if (
		roles.length !== 1 ||
		roles[0]?.platformRole.key !== PLATFORM_OWNER_ROLE.key ||
		!roles[0].platformRole.isSystem
	) {
		throw roleConflict();
	}
	const actual = roles[0].platformRole.permissions
		.map(({ platformPermission }) => platformPermission.key)
		.sort();
	const approved = PLATFORM_OWNER_PERMISSIONS.map(({ key }) => key).sort();
	if (actual.length !== approved.length || actual.some((key, index) => key !== approved[index])) {
		throw roleConflict();
	}
}

function createRecoveryCodes(): string[] {
	return Array.from({ length: PLATFORM_OWNER_RECOVERY_CODE_COUNT }, () => {
		const encoded = randomBytes(PLATFORM_OWNER_RECOVERY_CODE_BYTES).toString('hex').toUpperCase();
		return encoded.match(/.{1,4}/gu)?.join('-') ?? encoded;
	});
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function validateEmail(email: string): void {
	if (email.length > 254 || !isEmail(email, { allow_utf8_local_part: false })) {
		throw invalidInput('Enter a valid email address of at most 254 characters.');
	}
}

function validateDisplayName(displayName: string): string {
	const normalized = displayName.trim().replace(/\s+/gu, ' ');
	if (
		normalized.length < MINIMUM_DISPLAY_NAME_LENGTH ||
		normalized.length > MAXIMUM_DISPLAY_NAME_LENGTH ||
		containsControlCharacter(normalized)
	) {
		throw invalidInput('Enter a display name between 2 and 160 safe characters.');
	}
	return normalized;
}

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const characterCode = value.charCodeAt(index);
		if (characterCode <= 0x1f || characterCode === 0x7f) {
			return true;
		}
	}
	return false;
}

function validatePassword(password: Buffer, email: string): void {
	if (!acceptsBootstrapPassword(password, email)) {
		throw invalidInput(
			'Use 12 to 1024 characters within 1024 UTF-8 bytes, without controls or your email address.',
		);
	}
}

function invalidInput(message: string): PlatformBootstrapError {
	return new PlatformBootstrapError('BOOTSTRAP_INVALID_INPUT', message);
}

function roleConflict(): PlatformBootstrapError {
	return new PlatformBootstrapError(
		'BOOTSTRAP_ROLE_CONFLICT',
		'The platform owner role does not match the reviewed permission allowlist.',
	);
}

function translateTransactionError(error: unknown): Error {
	if (error instanceof PlatformBootstrapError) {
		return error;
	}
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error.code === 'P2034' || error.code === 'P2028')
	) {
		return new PlatformBootstrapError(
			'BOOTSTRAP_CONCURRENT_OPERATION',
			'The bootstrap transaction could not obtain exclusive execution; retry only after review.',
			{ cause: error },
		);
	}
	return new PlatformBootstrapError(
		'BOOTSTRAP_DATABASE_FAILED',
		'The database operation failed; verify migrations, role grants, and connectivity before retrying.',
		{ cause: error },
	);
}
