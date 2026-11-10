import { ApiProperty } from '@nestjs/swagger';

export class LivenessResponseDto {
	@ApiProperty({ example: 'ok', enum: ['ok'] })
	status!: 'ok';

	@ApiProperty({ example: 'akiba-api' })
	service!: string;

	@ApiProperty({ example: '0.1.0' })
	version!: string;

	@ApiProperty({ example: '2026-10-12T10:30:00.000Z' })
	timestamp!: string;

	@ApiProperty({ example: 42.75 })
	uptimeSeconds!: number;
}
