import { Controller, Get, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { config } from '@permguard/platform';
import { PG, REDIS } from './platform.module';
import { CacheInvalidator } from './authorization/cache-invalidator.service';

@Controller()
export class HealthController {
  constructor(
    @Inject(PG) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly invalidator: CacheInvalidator,
  ) {}

  @Get('health')
  async health() {
    const [postgres, redis] = await Promise.all([
      this.pool.query('SELECT 1').then(() => 'up' as const).catch(() => 'down' as const),
      this.redis.ping().then(() => 'up' as const).catch(() => 'down' as const),
    ]);
    // `ok` tracks Postgres alone. Redis being down costs latency and nothing
    // else, so reporting it unhealthy would take a node out of rotation for a
    // problem it can absorb.
    return {
      ok: postgres === 'up',
      node: config.nodeId,
      stores: { postgres, redis },
      ...this.invalidator.status(),
    };
  }
}
