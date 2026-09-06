import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  DecisionService,
  MemoryDecisionCache,
  PostgresGrantRepository,
  PostgresReachability,
  RedisDecisionCache,
} from '@permguard/authorization';
import { PG, REDIS } from '../platform.module';
import { CacheInvalidator } from './cache-invalidator.service';
import { AuthorizationController } from './authorization.controller';
import { DECISION_SERVICE, GRANT_REPOSITORY, L1_CACHE } from './tokens';



/**
 * A bounded context is a Nest module here, and the mapping is not decorative:
 * the only things this module exports are the two ports other contexts are
 * allowed to touch. Nothing outside it can reach a `Pool` and start reading the
 * `grants` table sideways.
 */
@Module({
  controllers: [AuthorizationController],
  providers: [
    CacheInvalidator,
    { provide: L1_CACHE, useFactory: () => new MemoryDecisionCache() },
    {
      provide: GRANT_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresGrantRepository(pool),
      inject: [PG],
    },
    {
      provide: DECISION_SERVICE,
      useFactory: (
        l1: MemoryDecisionCache,
        cache: Redis,
        pool: Pool,
        invalidator: CacheInvalidator,
      ) =>
        new DecisionService({
          l1,
          l2: new RedisDecisionCache(cache),
          generation: invalidator.generation,
          store: new PostgresReachability(pool),
        }),
      inject: [L1_CACHE, REDIS, PG, CacheInvalidator],
    },
  ],
  exports: [DECISION_SERVICE, GRANT_REPOSITORY, CacheInvalidator, L1_CACHE],
})
export class AuthorizationModule {}

export { DECISION_SERVICE, GRANT_REPOSITORY, L1_CACHE };
