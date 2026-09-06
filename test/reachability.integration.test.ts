import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PostgresReachability } from '@permguard/authorization';
import { pgPool } from '@permguard/platform';

/**
 * The inheritance rules, against a real Postgres.
 *
 * These are the assertions that stop the model drifting. Every one of them is a
 * sentence someone could reasonably expect to be false — "a member of a nested
 * team inherits the parent team's grants", "a grant on a folder reaches a file
 * inside it", "editor does not imply delete" — and each is a decision, not a
 * law of nature.
 */
describe('reachability (recursive CTE)', () => {
  let pool: Pool;
  let store: PostgresReachability;

  beforeAll(async () => {
    pool = pgPool();
    store = new PostgresReachability(pool);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM grants');
    if (rows[0]!.n === 0) throw new Error('run `npm run bootstrap` first');
  });

  afterAll(async () => {
    await pool.end();
  });

  const allowed = async (userId: string, permission: string, resourceId: string): Promise<boolean> =>
    (await store.check({ userId, permission: permission as never, resourceId })).allowed;

  it('grants reach down the resource tree', async () => {
    // engineering is editor on repo-core; repo-core-secrets is inside it.
    await expect(allowed('ada', 'write', 'repo-core-secrets')).resolves.toBe(true);
  });

  it('grants do not reach up the resource tree', async () => {
    // Nothing about repo-core gives you its parent org.
    await expect(allowed('ada', 'read', 'acme')).resolves.toBe(false);
  });

  it('grants do not leak sideways between siblings', async () => {
    await expect(allowed('ada', 'read', 'billing')).resolves.toBe(false);
  });

  it('membership is inherited upward through nested teams', async () => {
    // ada is in platform; platform is inside engineering; engineering holds the
    // grant. If this direction were reversed, everyone in a parent team would
    // silently gain every child team's access.
    await expect(allowed('ada', 'write', 'repo-core')).resolves.toBe(true);
  });

  it('a grant at the org root reaches everything under it', async () => {
    for (const resource of ['acme', 'repo-core', 'repo-core-secrets', 'repo-web', 'billing']) {
      await expect(allowed('linus', 'read', resource)).resolves.toBe(true);
    }
  });

  it('roles absorb downward but not upward', async () => {
    // engineering is editor on repo-core: write yes, delete no.
    await expect(allowed('grace', 'write', 'repo-core')).resolves.toBe(true);
    await expect(allowed('grace', 'delete', 'repo-core')).resolves.toBe(false);
  });

  it('a direct user grant works without any team', async () => {
    await expect(allowed('grace', 'delete', 'repo-web')).resolves.toBe(true);
  });

  it('an unrelated user reaches nothing', async () => {
    await expect(allowed('mallory', 'read', 'repo-core')).resolves.toBe(false);
    await expect(allowed('mallory', 'read', 'billing')).resolves.toBe(false);
  });

  it('a contractor reaches exactly what the contractors team was given', async () => {
    await expect(allowed('mallory', 'read', 'repo-web')).resolves.toBe(true);
    await expect(allowed('mallory', 'write', 'repo-web')).resolves.toBe(false);
  });

  it('an unknown user is denied rather than erroring', async () => {
    await expect(allowed('nobody-at-all', 'read', 'repo-web')).resolves.toBe(false);
  });
});
