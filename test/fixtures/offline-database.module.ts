import { Global, Module } from '@nestjs/common';
import { PrismaService, TenantTransactionService } from '@nexcoderw/akiba-db';

/** Test-only replacement: no adapter, pool, credentials or database lifecycle hooks. */
@Global()
@Module({
	providers: [{ provide: PrismaService, useValue: Object.freeze({}) }, TenantTransactionService],
	exports: [PrismaService, TenantTransactionService],
})
export class OfflineDatabaseModule {}
