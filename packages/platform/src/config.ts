/**
 * Every knob, read from the environment in one place.
 *
 * The defaults point at the ports in `docker-compose.yml` as seen from the
 * host, so `tsx bench/...` and `vitest --config vitest.integration.config.ts`
 * work against `npm run infra:up` with nothing exported.
 */
export const config = {
  pg: {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 55432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'permguard',
  },
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:56379',
  neo4j: {
    url: process.env.NEO4J_URL ?? 'bolt://localhost:57787',
    user: process.env.NEO4J_USER ?? 'neo4j',
    password: process.env.NEO4J_PASSWORD ?? 'permguard1',
  },
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','),
  nodeId: process.env.NODE_ID ?? 'local',
  generationBackstopMs: Number(process.env.GENERATION_BACKSTOP_MS ?? 5000),
  /**
   * How often the outbox relay looks for unpublished rows. This sits directly
   * inside the invalidation window and is the first knob to reach for when the
   * window is worse than expected — which is why it is a variable rather than a
   * literal buried in the worker.
   */
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS ?? 50),
  apiPort: Number(process.env.PORT ?? 3900),
  workerPort: Number(process.env.WORKER_PORT ?? 3910),
} as const;
