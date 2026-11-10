import type { ValidationError } from '@nestjs/common';

import { createValidationException } from '../../src/common/pipes/validation-exception.factory.js';

const secret = 'private-password-value';

describe('safe validation issues', () => {
	it('uses approved messages and stable nested paths without custom constraint text or values', () => {
		const exception = createValidationException([
			{
				property: 'profile',
				children: [
					{
						property: 'email',
						value: secret,
						target: { password: secret },
						constraints: { isEmail: `invalid ${secret}` },
					},
				],
			},
		]);
		expect(exception.getStatus()).toBe(400);
		expect(exception.getResponse()).toEqual({ code: 'VALIDATION_FAILED' });
		expect(exception.fieldErrors).toEqual([
			{ field: 'profile.email', code: 'INVALID_EMAIL', message: 'Enter a valid email address.' },
		]);
		expect(JSON.stringify(exception.fieldErrors)).not.toContain(secret);
	});

	it('bounds output and replaces attacker-selected unknown properties', () => {
		const errors: ValidationError[] = Array.from({ length: 100 }, (_, index) => ({
			property: `field${String(index)}`,
			constraints: { isString: secret },
		}));
		expect(createValidationException(errors).fieldErrors).toHaveLength(20);
		expect(
			createValidationException([
				{ property: secret, constraints: { whitelistValidation: secret } },
			]).fieldErrors,
		).toEqual([{ field: '$', code: 'UNEXPECTED_FIELD', message: 'Remove unexpected fields.' }]);
	});

	it('handles cyclic nesting and empty properties without recursion failures', () => {
		const cycle: ValidationError = { property: 'profile', children: [] };
		cycle.children = [cycle];
		expect(createValidationException([cycle]).getStatus()).toBe(400);
		expect(
			createValidationException([{ property: '', constraints: { unknownValue: secret } }])
				.fieldErrors[0],
		).toMatchObject({ field: '$', code: 'INVALID_OBJECT' });
	});
});
