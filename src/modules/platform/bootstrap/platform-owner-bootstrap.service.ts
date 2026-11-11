import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformStaffStatus, Prisma, PrismaService, UserStatus } from '@nexcoderw/akiba-db';

import { normalizeEmailIdentity } from '../../../common/identity/email-identity.js';
import type { EnvironmentVariables } from '../../../config/environment.types.js';
import { recordIdentityEvent } from '../../identity/identity-security.js';
import { PLATFORM_OWNER_PERMISSIONS, PLATFORM_OWNER_ROLE } from './platform-bootstrap.constants.js';
import { acquireBootstrapLock, verifyBootstrapDatabase } from './platform-bootstrap-database.js';
import {
	PlatformBootstrapError,
	type InitializePlatformOwnerInput,
	type PlatformBootstrapTarget,
} from './platform-bootstrap.types.js';

const TRANSACTION_TIMEOUT_MILLISECONDS = 15_000;

/** Reserves the first owner; enrollment cannot advance without a delivered mailbox proof. */
@Injectable()
export class PlatformOwnerBootstrapService {
	constructor(
		private readonly config: ConfigService<EnvironmentVariables, true>,
		private readonly prisma: PrismaService,
	) {}

	getTarget(): PlatformBootstrapTarget {
		this.assertEnabled();
		const databaseUrl = this.config.get('DATABASE_URL', { infer: true });
		if (databaseUrl === null) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_DISABLED',
				'Bootstrap requires a configured development or production connection.',
			);
		}
		const target = new URL(databaseUrl);
		return {
			environment: this.config.get('NODE_ENV', { infer: true }),
			databaseHost: target.hostname,
			databaseName: decodeURIComponent(target.pathname.slice(1)),
			databaseRole: decodeURIComponent(target.username),
		};
	}

	async initialize(input: InitializePlatformOwnerInput): Promise<void> {
		this.assertEnabled();
		const email = normalizeEmailIdentity(input.email);
		if (email === null) throw invalidInput('Enter a supported email address.');
		const displayName = input.displayName.trim().replace(/\s+/gu, ' ');
		if (displayName.length < 2 || displayName.length > 160 || /[\p{Cc}\p{Cs}]/u.test(displayName)) {
			throw invalidInput('Enter a display name between 2 and 160 safe characters.');
		}
		const requestId = `req_${randomUUID()}`;
		try {
			await this.prisma.$transaction(async (transaction) => {
				await acquireBootstrapLock(transaction);
				await this.verifyDatabase(transaction);
				// Pending, disabled and suspended staff all permanently reserve initialization.
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
						platformStaff: { create: { status: PlatformStaffStatus.PENDING } },
					},
					select: { id: true, identityVersion: true, platformStaff: { select: { id: true } } },
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
				await recordIdentityEvent(
					transaction,
					{
						actorKind: 'bootstrap',
						actorPlatformStaffId: identity.platformStaff.id,
						requestId,
					},
					{
						userId: identity.id,
						action: 'identity_created',
						identityVersion: identity.identityVersion,
					},
				);
			}, transactionOptions);
		} catch (error: unknown) {
			throw translateTransactionError(error);
		}
	}

	/** No operator assertion can substitute for a delivered, consumed mailbox challenge. */
	activate(): never {
		this.assertEnabled();
		throw new PlatformBootstrapError(
			'BOOTSTRAP_ENROLLMENT_UNAVAILABLE',
			'Owner activation requires a verified mailbox challenge and protected credential enrollment.',
		);
	}

	private async verifyDatabase(transaction: Prisma.TransactionClient): Promise<void> {
		const target = this.getTarget();
		await verifyBootstrapDatabase(transaction, {
			databaseName: target.databaseName,
			databaseRole: target.databaseRole,
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
			permissions: { select: { platformPermission: { select: { key: true } } } },
		},
	});
	if (existingRole !== null) {
		if (!existingRole.isSystem) throw roleConflict();
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
	if (error instanceof PlatformBootstrapError) return error;
	if (typeof error === 'object' && error !== null && 'code' in error) {
		if (error.code === 'P2034' || error.code === 'P2028') {
			return new PlatformBootstrapError(
				'BOOTSTRAP_CONCURRENT_OPERATION',
				'The bootstrap transaction could not obtain exclusive execution; review its outcome.',
				{ cause: error },
			);
		}
		if (error.code === 'P2002') {
			return new PlatformBootstrapError(
				'BOOTSTRAP_STATE_CONFLICT',
				'The first-owner reservation conflicts with existing state; review before retrying.',
				{ cause: error },
			);
		}
	}
	return new PlatformBootstrapError(
		'BOOTSTRAP_DATABASE_FAILED',
		'The database operation failed; verify migrations, grants and connectivity before retrying.',
		{ cause: error },
	);
}
