import { Controller, Get, Inject, Module, Param, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostgresAuditLog, type AuditLog } from '@permguard/audit';
import { PG } from '../platform.module';

export const AUDIT_LOG = Symbol('AUDIT_LOG');

@Controller('audit')
class AuditController {
  constructor(@Inject(AUDIT_LOG) private readonly log: AuditLog) {}

  @Get('resource/:resourceId')
  async forResource(@Param('resourceId') resourceId: string, @Query('limit') limit?: string) {
    return { entries: await this.log.forResource(resourceId, Number(limit ?? 50)) };
  }

  @Get('count')
  async count() {
    return { count: await this.log.count() };
  }
}

@Module({
  controllers: [AuditController],
  providers: [
    { provide: AUDIT_LOG, useFactory: (pool: Pool) => new PostgresAuditLog(pool), inject: [PG] },
  ],
  exports: [AUDIT_LOG],
})
export class AuditModule {}
