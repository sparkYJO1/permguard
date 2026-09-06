import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Driver } from 'neo4j-driver';
import type { Pool } from 'pg';
import { neo4jDriver, pgPool, redis } from '@permguard/platform';

export const PG = Symbol('PG');
export const REDIS = Symbol('REDIS');
export const NEO4J = Symbol('NEO4J');

/**
 * Connections, and nothing else. The domain layers never see these symbols —
 * they take the ports defined next to them, and the modules below do the
 * wiring. That is the whole reason `DecisionService` can be unit tested with no
 * Docker running.
 */
@Global()
@Module({
  providers: [
    { provide: PG, useFactory: pgPool },
    { provide: REDIS, useFactory: redis },
    { provide: NEO4J, useFactory: neo4jDriver },
  ],
  exports: [PG, REDIS, NEO4J],
})
export class PlatformModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    /* connections are closed by the process exiting; compose sends SIGTERM */
  }
}

export type { Driver, Pool, Redis };
