import { createCipheriv } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { argon2id, hash } from 'argon2';
import * as OTPAuth from 'otpauth';

import type { EnvironmentVariables } from '../../src/config/environment.types.js';
import { validateEnvironment } from '../../src/config/environment.validation.js';
import { PlatformPasswordService } from '../../src/modules/platform/auth/platform-password.service.js';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service.js';
import { PlatformTotpService } from '../../src/modules/platform/auth/platform-totp.service.js';

describe('platform authentication cryptography', () => {
	const environment = validateEnvironment({ NODE_ENV: 'test' });
	const config = new ConfigService<EnvironmentVariables, true>(environment);

	it('verifies approved Argon2id hashes and rejects weak parameters', async () => {
		const passwords = new PlatformPasswordService(config);
		const provisionedPassword = Buffer.from('fictional provisioned password', 'utf8');
		const provisionedHash = await passwords.hash(provisionedPassword);
		const approvedHash = await hash('fictional strong password', {
			type: argon2id,
			memoryCost: 65_536,
			timeCost: 3,
			parallelism: 1,
		});
		const weakHash = await hash('fictional strong password', {
			type: argon2id,
			memoryCost: 4_096,
			timeCost: 2,
			parallelism: 1,
		});

		await expect(passwords.verify(approvedHash, 'fictional strong password')).resolves.toBe(true);
		await expect(passwords.verify(approvedHash, 'incorrect password')).resolves.toBe(false);
		await expect(passwords.verify(weakHash, 'fictional strong password')).resolves.toBe(false);
		await expect(
			passwords.verify(provisionedHash, provisionedPassword.toString('utf8')),
		).resolves.toBe(true);
	});

	it('creates opaque tokens and stable keyed digests', () => {
		const tokens = new PlatformTokenService(config);
		const first = tokens.createToken();
		const second = tokens.createToken();

		expect(first).not.toBe(second);
		expect(tokens.digest(first)).toHaveLength(64);
		expect(tokens.digest(first)).toBe(tokens.digest(first));
		expect(tokens.equal(first, first)).toBe(true);
		expect(tokens.equal(first, second)).toBe(false);
	});

	it('generates ten independent 128-bit recovery values with purpose-separated keyed verifiers', () => {
		const tokens = new PlatformTokenService(config);
		const codes = tokens.createRecoveryCodes();
		expect(codes).toHaveLength(10);
		expect(new Set([...codes, ...tokens.createRecoveryCodes()]).size).toBe(20);
		for (const code of codes) {
			expect(code).toMatch(/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/u);
			expect(tokens.recoveryCodeDigest(code)).toHaveLength(64);
			expect(tokens.recoveryCodeDigest(code)).not.toBe(tokens.digest(code));
			expect(tokens.recoveryCodeDigest(code.toLowerCase())).toBe(tokens.recoveryCodeDigest(code));
		}
	});

	it('binds email OTP digests to one challenge and verified mailbox', () => {
		const tokens = new PlatformTokenService(config);
		const digest = tokens.emailOtpDigest('challenge-a', 'admin@example.com', '012345');
		expect(digest).toHaveLength(64);
		expect(digest).toBe(tokens.emailOtpDigest('challenge-a', 'ADMIN@example.com', '012345'));
		expect(digest).not.toBe(tokens.emailOtpDigest('challenge-b', 'admin@example.com', '012345'));
		expect(digest).not.toBe(tokens.emailOtpDigest('challenge-a', 'other@example.com', '012345'));
		expect(digest).not.toBe(tokens.emailOtpDigest('challenge-a', 'admin@example.com', '012346'));
	});

	it('decrypts an authenticated secret and validates the current TOTP step', () => {
		const staffId = 'a652ac64-47b5-499e-a849-dca02166c46b';
		const keyId = 'local-v1';
		const version = 1;
		const key = Buffer.alloc(32);
		const initializationVector = Buffer.alloc(12, 1);
		const secret = 'JBSWY3DPEHPK3PXP';
		const now = new Date('2030-01-01T00:00:00.000Z');
		const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
		cipher.setAAD(Buffer.from(`${staffId}:${keyId}:${String(version)}`, 'utf8'));
		const encryptedSecret = Buffer.concat([
			cipher.update(Buffer.from(secret, 'utf8')),
			cipher.final(),
		]);
		const token = new OTPAuth.TOTP({
			algorithm: 'SHA1',
			digits: 6,
			period: 30,
			secret: OTPAuth.Secret.fromBase32(secret),
		}).generate({ timestamp: now.getTime() });

		expect(
			new PlatformTotpService(config).verify(
				{
					platformStaffId: staffId,
					encryptedSecret,
					initializationVector,
					authenticationTag: cipher.getAuthTag(),
					encryptionKeyId: keyId,
					encryptionVersion: version,
				},
				token,
				now,
			),
		).toEqual({ timeStep: BigInt(Math.floor(now.getTime() / 30_000)) });
	});

	it('creates enrollment material compatible with the established verifier', () => {
		const staffId = 'a652ac64-47b5-499e-a849-dca02166c46b';
		const totpService = new PlatformTotpService(config);
		const enrollment = totpService.createEnrollment(staffId, 'owner@example.com');
		const otherEnrollment = totpService.createEnrollment(staffId, 'owner@example.com');
		const now = new Date('2030-01-01T00:00:00.000Z');
		const token = new OTPAuth.TOTP({
			algorithm: 'SHA1',
			digits: 6,
			period: 30,
			secret: OTPAuth.Secret.fromBase32(enrollment.secret),
		}).generate({ timestamp: now.getTime() });

		expect(enrollment.enrollmentUri).toContain('otpauth://totp/');
		expect(enrollment.enrollmentUri).toContain('issuer=Akiba');
		expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/u);
		expect(enrollment.secret).not.toBe(otherEnrollment.secret);
		expect(enrollment.initializationVector).toHaveLength(12);
		expect(Buffer.from(enrollment.encryptedSecret).toString('utf8')).not.toContain(
			enrollment.secret,
		);
		expect(totpService.verify(enrollment, token, now)).toEqual({
			timeStep: BigInt(Math.floor(now.getTime() / 30_000)),
		});
		expect(
			totpService.verify({ ...enrollment, platformStaffId: 'different-staff' }, token, now),
		).toBeNull();
		expect(
			totpService.verify({ ...enrollment, authenticationTag: Buffer.alloc(16) }, token, now),
		).toBeNull();
		expect(totpService.verify(enrollment, token, new Date(now.getTime() + 90_000))).toBeNull();
	});
});
