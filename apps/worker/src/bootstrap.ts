import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_SCHEMA } from 'nestjs-outbox';
import { pgPool, redis, redisReady, waitFor } from '@permguard/platform';

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

  await waitFor('postgres', () => pool.query('SELECT 1'));
  await redisReady(cache);
  await waitFor('redis', () => cache.ping());

  const schema = readFileSync(resolveSchema(), 'utf8');
  await pool.query(schema);
  await pool.query(OUTBOX_SCHEMA);
  console.log('[bootstrap] schema applied');

  const { seed } = await import('./seed');
  await seed(pool);
  console.log('[bootstrap] seed applied');

  // No cache priming and no generation to seed: a node reads the current
  // generation straight out of `max(outbox.id)` when it starts.
  await pool.end();
  cache.disconnect();
}

function resolveSchema(): string {
  // Same file whether this runs from `dist/` in the image or from `src/` under
  // tsx on a laptop.
  for (const candidate of ['../../../db/schema.sql', '../../db/schema.sql', 'db/schema.sql']) {
    try {
      const p = join(__dirname, candidate);
      readFileSync(p);
      return p;
    } catch {
      /* try the next one */
    }
  }
  return join(process.cwd(), 'db/schema.sql');
}

main().catch((err) => {
  console.error('[bootstrap] failed', err);
  process.exit(1);
});
