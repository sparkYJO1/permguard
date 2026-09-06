import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_SCHEMA } from 'nestjs-outbox';
import { Neo4jProjector, PgKgProjector } from '@permguard/authorization';
import { neo4jDriver, pgPool, redis, redisReady, waitFor } from '@permguard/platform';

/**
 * Runs once, before anything else starts.
 *
 * Schema and seed. An API node that starts against a half-built system would
 * answer `unavailable` for its first few seconds, which is correct behaviour
 * and a terrible first impression — so the compose file makes everything wait
 * on this exiting cleanly.
 */
async function main(): Promise<void> {
  const pool = pgPool();
  const cache = redis();
  const driver = neo4jDriver();

  await waitFor('postgres', () => pool.query('SELECT 1'));
  await waitFor('neo4j', async () => {
    const s = driver.session();
    try {
      await s.run('RETURN 1');
    } finally {
      await s.close();
    }
  });
  await redisReady(cache);
  await waitFor('redis', () => cache.ping());

  await pool.query(readFileSync(resolveSchema('schema.sql'), 'utf8'));
  await pool.query(readFileSync(resolveSchema('kg-schema.sql'), 'utf8'));
  await pool.query(OUTBOX_SCHEMA);
  console.log('[bootstrap] schema applied');

  const { seed } = await import('./seed');
  await seed(pool);
  console.log('[bootstrap] seed applied');

  // The property graph is a projection of the tables above, and it is rebuilt
  // rather than patched. After this, grant writes maintain their own edges
  // inside the same transaction as the grant row, so there is no window in
  // which the graph and the source of truth disagree.
  await new PgKgProjector(pool).rebuild();

  // Two projections of one graph. Postgres holds it transactionally; Neo4j
  // holds the copy the traversals actually run against. Both are rebuilt from
  // the same tables so `bench/kg-engines.ts` can assert they agree.
  const neo = new Neo4jProjector(driver);
  await neo.ensureConstraints();
  await neo.syncTopology(pool);
  await neo.syncGrants(pool);
  console.log('[bootstrap] knowledge graph projected (postgres + neo4j)');

  // No cache priming and no generation to seed: a node reads the current
  // generation straight out of `max(outbox.id)` when it starts.
  await pool.end();
  await driver.close();
  cache.disconnect();
}

function resolveSchema(name: string): string {
  // Same file whether this runs from `dist/` in the image or from `src/` under
  // tsx on a laptop.
  for (const candidate of [`../../../db/${name}`, `../../db/${name}`, `db/${name}`]) {
    try {
      const p = join(__dirname, candidate);
      readFileSync(p);
      return p;
    } catch {
      /* try the next one */
    }
  }
  return join(process.cwd(), `db/${name}`);
}

main().catch((err) => {
  console.error('[bootstrap] failed', err);
  process.exit(1);
});
