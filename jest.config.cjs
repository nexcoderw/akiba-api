/** @type {import('jest').Config} */
const common = {
	extensionsToTreatAsEsm: ['.ts'],
	moduleFileExtensions: ['js', 'json', 'ts', 'mjs'],
	moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
	testEnvironment: 'node',
	transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }] },
};

module.exports = {
	projects: [
		{ ...common, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.spec.ts'] },
		{
			...common,
			displayName: 'integration',
			testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
		},
		{ ...common, displayName: 'e2e', testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'] },
	],
};
