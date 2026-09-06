import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Driver } from 'neo4j-driver';
import type { Pool } from 'pg';
import {
  DecisionService,
  GraphService,
  MemoryDecisionCache,
  Neo4jQueries,
  PgKgQueries,
  PostgresGrantRepository,
  PostgresReachability,
  RedisDecisionCache,
} from '@permguard/authorization';
import { NEO4J, PG, REDIS } from '../platform.module';
import { CacheInvalidator } from './cache-invalidator.service';
import { AuthorizationController } from './authorization.controller';
import { DECISION_SERVICE, GRANT_REPOSITORY, KG_QUERIES, L1_CACHE } from './tokens';
import { ExplainController } from './explain.controller';



/**
 * A bounded context is a Nest module here, and the mapping is not decorative:
 * the only things this module exports are the two ports other contexts are
 * allowed to touch. Nothing outside it can reach a `Pool` and start reading the
 * `grants` table sideways.
 */
@Module({
  controllers: [AuthorizationController, ExplainController],
  providers: [
    CacheInvalidator,
    { provide: L1_CACHE, useFactory: () => new MemoryDecisionCache() },
    {
      // Neo4j leads on every traversal and its lead grows with the graph; the
      // Postgres property graph is behind it because it is written in the
      // grant's own transaction and cannot be stale. ADR-0007.
      provide: KG_QUERIES,
      useFactory: (driver: Driver, pool: Pool) =>
        new GraphService({
          primary: new Neo4jQueries(driver),
          fallback: new PgKgQueries(pool),
        }),
      inject: [NEO4J, PG],
    },
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
  exports: [DECISION_SERVICE, GRANT_REPOSITORY, KG_QUERIES, CacheInvalidator, L1_CACHE],
})
export class AuthorizationModule {}

export { DECISION_SERVICE, GRANT_REPOSITORY, KG_QUERIES, L1_CACHE };
