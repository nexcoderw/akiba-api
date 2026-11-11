import 'reflect-metadata';

import { createInterface } from 'node:readline/promises';

import { NestFactory } from '@nestjs/core';

import { PlatformBootstrapCliModule } from '../modules/platform/bootstrap/platform-bootstrap-cli.module.js';
import { PlatformOwnerBootstrapService } from '../modules/platform/bootstrap/platform-owner-bootstrap.service.js';
import {
	PlatformBootstrapError,
	type PlatformBootstrapStage,
	type PlatformBootstrapTarget,
} from '../modules/platform/bootstrap/platform-bootstrap.types.js';

const INITIALIZE_AUTHORIZATION = 'AUTHORIZE FIRST PLATFORM OWNER';

async function run(): Promise<void> {
	const stage = parseStage(process.argv[2]);
	const selectedEnvironment = parseEnvironment(process.argv[3]);
	if (process.argv.length !== 4 || process.env.NODE_ENV !== selectedEnvironment) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'Select the same explicit development or production environment in NODE_ENV and the command.',
		);
	}
	if (stage === 'activate') {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_ENROLLMENT_UNAVAILABLE',
			'Owner activation requires a verified mailbox challenge and protected credential enrollment.',
		);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'Bootstrap requires an attached interactive terminal.',
		);
	}

	const application = await NestFactory.createApplicationContext(PlatformBootstrapCliModule, {
		logger: false,
		abortOnError: false,
	});
	const prompts = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		const bootstrap = application.get(PlatformOwnerBootstrapService);
		const target = bootstrap.getTarget();
		if (target.environment !== selectedEnvironment) {
			throw new PlatformBootstrapError(
				'BOOTSTRAP_UNSAFE_DATABASE',
				'The configured environment does not match the selected bootstrap target.',
			);
		}
		await confirmTarget(prompts.question.bind(prompts), target);
		await initialize(prompts.question.bind(prompts), bootstrap, selectedEnvironment);
	} finally {
		prompts.close();
		await application.close();
	}
}

async function confirmTarget(
	question: (prompt: string) => Promise<string>,
	target: PlatformBootstrapTarget,
): Promise<void> {
	writeLine('Platform owner bootstrap is a privileged, one-time operation.');
	writeLine(`Environment: ${target.environment}`);
	writeLine(`Database target: ${target.databaseHost}/${target.databaseName}`);
	writeLine(`Database user: ${target.databaseRole}`);
	const phrase =
		`CONFIRM ${target.environment} ${target.databaseHost}/${target.databaseName} ` +
		target.databaseRole;
	if ((await question(`Type "${phrase}" to continue: `)) !== phrase) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'The database target confirmation did not match.',
		);
	}
}

async function initialize(
	question: (prompt: string) => Promise<string>,
	bootstrap: PlatformOwnerBootstrapService,
	environment: string,
): Promise<void> {
	const phrase =
		environment === 'production'
			? 'AUTHORIZE PRODUCTION FIRST PLATFORM OWNER'
			: INITIALIZE_AUTHORIZATION;
	if ((await question(`Type "${phrase}" to authorize initialization: `)) !== phrase) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'First-owner initialization was not authorized.',
		);
	}
	const email = await question('Owner email: ');
	const confirmation = await question('Confirm owner email: ');
	if (email !== confirmation) {
		throw new PlatformBootstrapError(
			'BOOTSTRAP_INVALID_INPUT',
			'The owner email confirmation did not match.',
		);
	}
	const displayName = await question('Owner display name: ');
	await bootstrap.initialize({ email, displayName });
	writeLine('The first owner is reserved and remains pending.');
	writeLine('No password or MFA factor was enrolled.');
	writeLine('Activation requires a protected mailbox challenge and enrollment flow.');
}

function parseStage(value: string | undefined): PlatformBootstrapStage {
	if (value === 'initialize' || value === 'activate') return value;
	throw new PlatformBootstrapError(
		'BOOTSTRAP_INVALID_INPUT',
		'Choose exactly one bootstrap stage: initialize or activate.',
	);
}

function parseEnvironment(value: string | undefined): 'development' | 'production' {
	if (value === 'development' || value === 'production') return value;
	throw new PlatformBootstrapError(
		'BOOTSTRAP_INVALID_INPUT',
		'Choose exactly one target: development or production.',
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
