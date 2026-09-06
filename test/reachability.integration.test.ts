import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgKgQueries, PgKgProjector, PostgresReachability } from '@permguard/authorization';
import { pgPool } from '@permguard/platform';

/**
 * The inheritance rules, against a real Postgres.
 *
 * This builds its own org and tears it down. It used to assert against the demo
 * seed, which meant clicking "revoke" in the UI broke the test suite — and the
 * failure was a bare `expected false to be true` pointing nowhere near the
 * cause. CI never saw it because CI gets a fresh database. Tests that depend on
 * mutable shared state are tests that fail for reasons unrelated to the change
 * being tested.
 *
 * Every assertion here is a sentence someone could reasonably expect to be
 * false — "a member of a nested team inherits the parent team's grants", "a
 * grant on a folder reaches a file inside it", "editor does not imply delete".
 * Each is a decision, not a law of nature.
 */
const P = 'rt'; // prefix, so nothing here can collide with the demo data

describe('reachability', () => {
  let pool: Pool;
  let relational: PostgresReachability;
  let kg: PgKgQueries;

  beforeAll(async () => {
    pool = pgPool();
    relational = new PostgresReachability(pool);
    kg = new PgKgQueries(pool);
    await teardown(pool);
    await setup(pool);
    await new PgKgProjector(pool).rebuild();
  }, 60_000);

  afterAll(async () => {
    await teardown(pool);
    // The projection is rebuilt from what is left, so the next reader does not
    // see edges for rows this test deleted.
    await new PgKgProjector(pool).rebuild().catch(() => undefined);
    await pool.end();
  });

  /**
   * Both engines answer every case. They are separate implementations of the
   * same rules — one over the normalized tables, one over the property graph —
   * and a rule that holds in only one of them is a bug in whichever is wrong.
   */
  const allowed = async (userId: string, permission: string, resourceId: string): Promise<boolean> => {
    const a = await relational.check({
      userId: `${P}-${userId}`,
      permission: permission as never,
      resourceId: `${P}-${resourceId}`,
    });
    const b = await kg.check(`${P}-${userId}`, permission as never, `${P}-${resourceId}`);
    expect(
      a.allowed,
      `relational and pg-kg disagree on ${userId}/${permission}/${resourceId}`,
    ).toBe(b);
    return a.allowed;
  };

  it('grants reach down the resource tree', async () => {
    await expect(allowed('ada', 'write', 'secrets')).resolves.toBe(true);
  });

  it('grants do not reach up the resource tree', async () => {
    await expect(allowed('ada', 'read', 'org')).resolves.toBe(false);
  });

  it('grants do not leak sideways between siblings', async () => {
    await expect(allowed('ada', 'read', 'billing')).resolves.toBe(false);
  });

  it('membership is inherited upward through nested teams', async () => {
    // ada is in platform; platform is inside engineering; engineering holds the
    // grant. Reversed, everyone in a parent team would gain every child's access.
    await expect(allowed('ada', 'write', 'core')).resolves.toBe(true);
  });

  it('a grant at the org root reaches everything under it', async () => {
    for (const r of ['org', 'core', 'secrets', 'web', 'billing']) {
      await expect(allowed('linus', 'read', r)).resolves.toBe(true);
    }
  });

  it('roles absorb downward but not upward', async () => {
    await expect(allowed('grace', 'write', 'core')).resolves.toBe(true);
    await expect(allowed('grace', 'delete', 'core')).resolves.toBe(false);
  });

  it('a direct user grant works without any team', async () => {
    await expect(allowed('grace', 'delete', 'web')).resolves.toBe(true);
  });

  it('an unrelated user reaches nothing', async () => {
    await expect(allowed('mallory', 'read', 'core')).resolves.toBe(false);
    await expect(allowed('mallory', 'read', 'billing')).resolves.toBe(false);
  });

  it('a contractor reaches exactly what their team was given', async () => {
    await expect(allowed('mallory', 'read', 'web')).resolves.toBe(true);
    await expect(allowed('mallory', 'write', 'web')).resolves.toBe(false);
  });

  it('an unknown user is denied rather than erroring', async () => {
    await expect(allowed('nobody-at-all', 'read', 'web')).resolves.toBe(false);
  });

  it('revoking a grant removes exactly the access it conferred', async () => {
    // The property the demo shows, asserted on data this test owns, so running
    // it cannot damage anything else.
    expect(await allowed('mallory', 'read', 'web')).toBe(true);
    await pool.query(`DELETE FROM grants WHERE id = '${P}-g-contractors'`);
    await new PgKgProjector(pool).rebuild();

    expect(await allowed('mallory', 'read', 'web')).toBe(false);
    // grace held `web` directly and keeps it.
    expect(await allowed('grace', 'delete', 'web')).toBe(true);
  });
});

async function setup(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO teams (id, display_name, parent_id) VALUES
      ('${P}-everyone','e',NULL),
      ('${P}-engineering','e','${P}-everyone'),
      ('${P}-platform','p','${P}-engineering'),
      ('${P}-product','p','${P}-engineering'),
      ('${P}-security','s','${P}-everyone'),
      ('${P}-contractors','c','${P}-everyone');

    INSERT INTO users (id, display_name) VALUES
      ('${P}-ada','a'),('${P}-grace','g'),('${P}-linus','l'),('${P}-mallory','m');

    INSERT INTO memberships (user_id, team_id) VALUES
      ('${P}-ada','${P}-platform'),
      ('${P}-grace','${P}-product'),
      ('${P}-linus','${P}-security'),
      ('${P}-mallory','${P}-contractors');

    INSERT INTO resources (id, kind, parent_id) VALUES
      ('${P}-org','org',NULL),
      ('${P}-core','repo','${P}-org'),
      ('${P}-secrets','path','${P}-core'),
      ('${P}-web','repo','${P}-org'),
      ('${P}-billing','service','${P}-org');

    INSERT INTO grants (id, subject_kind, subject_id, role, resource_id) VALUES
      ('${P}-g-eng','team','${P}-engineering','editor','${P}-core'),
      ('${P}-g-platform','team','${P}-platform','owner','${P}-secrets'),
      ('${P}-g-security','team','${P}-security','owner','${P}-org'),
      ('${P}-g-contractors','team','${P}-contractors','viewer','${P}-web'),
      ('${P}-g-grace','user','${P}-grace','owner','${P}-web');
  `);
}

async function teardown(pool: Pool): Promise<void> {
  await pool.query(`
    DELETE FROM grants      WHERE id LIKE '${P}-%';
    DELETE FROM memberships WHERE user_id LIKE '${P}-%';
    DELETE FROM resources   WHERE id LIKE '${P}-%';
    DELETE FROM users       WHERE id LIKE '${P}-%';
    DELETE FROM teams       WHERE id LIKE '${P}-%';
  `);
}
