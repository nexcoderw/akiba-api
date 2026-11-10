import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { ApiErrorCode } from '../errors/api-error-code.js';
import type { FieldErrorCode } from '../errors/validation-issue.js';

export class ApiErrorDetailDto {
	@ApiProperty({ example: 'profile.email' })
	field!: string;

	@ApiProperty({ example: 'INVALID_EMAIL' })
	code!: FieldErrorCode;

	@ApiProperty({ example: 'Enter a valid email address.' })
	message!: string;
}

/** RFC 9457 response. No request paths, rejected values or implementation details are serialized. */
export class ApiErrorResponseDto {
	@ApiProperty({ example: 'urn:akiba:problem:validation-failed' })
	type!: string;

	@ApiProperty({ example: 'Please check your information' })
	title!: string;

	@ApiProperty({ example: 400, minimum: 400, maximum: 599 })
	status!: number;

	@ApiProperty({ example: 'Some fields need to be corrected.' })
	detail!: string;

	@ApiProperty({ example: 'VALIDATION_FAILED' })
	code!: ApiErrorCode;

	@ApiProperty({ example: 'req_9a14de53-a456-4b8d-9676-106cc5caa2ad' })
	requestId!: string;

	@ApiPropertyOptional({ type: [ApiErrorDetailDto], maxItems: 20 })
	errors?: ApiErrorDetailDto[];
}
