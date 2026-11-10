import 'reflect-metadata';

import { timingSafeEqual } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { NestFactory } from '@nestjs/core';

import { PlatformBootstrapCliModule } from '../modules/platform/bootstrap/platform-bootstrap-cli.module.js';
import { PlatformOwnerBootstrapService } from '../modules/platform/bootstrap/platform-owner-bootstrap.service.js';
import {
	PlatformBootstrapError,
	type PlatformBootstrapStage,
	type PlatformBootstrapTarget,
} from '../modules/platform/bootstrap/platform-bootstrap.types.js';

const INITIALIZE_AUTHORIZATION = 'AUTHORIZE FIRST PLATFORM OWNER';
const ACTIVATE_AUTHORIZATION = 'ACTIVATE FIRST PLATFORM OWNER';
const EMAIL_VERIFICATION_CONFIRMATION = 'MAILBOX OWNERSHIP VERIFIED';

class MutedTerminalOutput extends Writable {
	muted = false;

	override _write(
		chunk: Buffer | string,
		encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		if (!this.muted) {
			if (typeof chunk === 'string') {
				process.stdout.write(chunk, encoding);
			} else {
				process.stdout.write(chunk);
			}
		}
		callback();
	}
}

class OperatorPrompts {
	private readonly output = new MutedTerminalOutput();
	private readonly input: Interface;

	constructor() {
		this.input = createInterface({ input: process.stdin, output: this.output, terminal: true });
	}

	async text(question: string): Promise<string> {
		return await this.input.question(question);
	}

	async secret(question: string): Promise<Buffer> {
		process.stdout.write(question);
		this.output.muted = true;
		try {
			return Buffer.from(await this.input.question(''), 'utf8');
		} finally {
			this.output.muted = false;
			process.stdout.write('\n');
		}
	}

	close(): void {
		this.input.close();
	}
}

async function run(): Promise<void> {
	const stage = parseStage(process.argv[2]);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'Bootstrap requires an attached interactive terminal.',
		);
	}

	const application = await NestFactory.createApplicationContext(PlatformBootstrapCliModule, {
		logger: false,
		// Let the sanitized CLI error handler report startup failures instead of Nest exiting silently.
		abortOnError: false,
	});
	const prompts = new OperatorPrompts();
	try {
		const bootstrap = application.get(PlatformOwnerBootstrapService);
		await confirmTarget(prompts, bootstrap.getTarget());
		if (stage === 'initialize') {
			await initialize(prompts, bootstrap);
		} else {
			await activate(prompts, bootstrap);
		}
	} finally {
		prompts.close();
		await application.close();
	}
}

async function confirmTarget(
	prompts: OperatorPrompts,
	target: PlatformBootstrapTarget,
): Promise<void> {
	writeLine('Platform owner bootstrap is a privileged, one-time operation.');
	writeLine(`Environment: ${target.environment}`);
	writeLine(`Database target: ${target.databaseHost}/${target.databaseName}`);
	writeLine(`Database user: ${target.databaseRole}`);
	const phrase = `CONFIRM ${target.environment} ${target.databaseHost}/${target.databaseName} ${target.databaseRole}`;
	const confirmation = await prompts.text(`Type "${phrase}" to continue: `);
	if (confirmation !== phrase) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'The database target confirmation did not match.',
		);
	}
}

async function initialize(
	prompts: OperatorPrompts,
	bootstrap: PlatformOwnerBootstrapService,
): Promise<void> {
	if (
		(await prompts.text(`Type "${INITIALIZE_AUTHORIZATION}" to authorize initialization: `)) !==
		INITIALIZE_AUTHORIZATION
	) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'First-owner initialization was not authorized.',
		);
	}
	const email = await prompts.text('Owner email: ');
	const displayName = await prompts.text('Owner display name: ');
	const password = await prompts.secret('Owner password (input hidden): ');
	const confirmation = await prompts.secret('Confirm owner password (input hidden): ');
	try {
		if (password.length !== confirmation.length || !timingSafeEqual(password, confirmation)) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_INVALID_INPUT',
				'The password confirmation did not match.',
			);
		}
		const enrollment = await bootstrap.initialize({ email, displayName, password });
		writeLine('Pending owner initialization completed. The account is not active.');
		writeLine(
			'Enroll this TOTP factor now. The secret is displayed only in this terminal session.',
		);
		writeLine(`Enrollment URI: ${enrollment.enrollmentUri}`);
		writeLine(`Manual secret: ${enrollment.secret}`);
		writeLine('After independent mailbox verification, run the activation command.');
	} finally {
		password.fill(0);
		confirmation.fill(0);
	}
}

async function activate(
	prompts: OperatorPrompts,
	bootstrap: PlatformOwnerBootstrapService,
): Promise<void> {
	if (
		(await prompts.text(`Type "${ACTIVATE_AUTHORIZATION}" to authorize activation: `)) !==
		ACTIVATE_AUTHORIZATION
	) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'First-owner activation was not authorized.',
		);
	}
	const email = await prompts.text('Pending owner email: ');
	const totpCodeBuffer = await prompts.secret('Current six-digit TOTP code (input hidden): ');
	try {
		const emailConfirmation = await prompts.text(
			'After completing the independent mailbox challenge, type ' +
				`"${EMAIL_VERIFICATION_CONFIRMATION}": `,
		);
		const result = await bootstrap.activate({
			email,
			totpCode: totpCodeBuffer.toString('utf8'),
			emailOwnershipVerified: emailConfirmation === EMAIL_VERIFICATION_CONFIRMATION,
		});
		writeLine('The first platform owner is active with confirmed MFA.');
		writeLine('Store these single-use recovery codes in an approved offline secret store.');
		writeLine('They will not be displayed again:');
		for (const code of result.recoveryCodes) {
			writeLine(code);
		}
	} finally {
		totpCodeBuffer.fill(0);
	}
}

function parseStage(value: string | undefined): PlatformBootstrapStage {
	if (value === 'initialize' || value === 'activate') {
		return value;
	}
	throw new PlatformBootstrapError(
		'BOOTSTRAP_INVALID_INPUT',
		'Choose exactly one bootstrap stage: initialize or activate.',
	);
}

function writeLine(value: string): void {
	process.stdout.write(`${value}\n`);
}

void run().catch((error: unknown) => {
	const safeMessage =
		error instanceof PlatformBootstrapError
			? `${error.code}: ${error.message}`
			: 'BOOTSTRAP_FAILED: The operation failed closed; inspect protected operational diagnostics.';
	process.stderr.write(`${safeMessage}\n`);
	process.exitCode = 1;
});
