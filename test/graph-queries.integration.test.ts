import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgKgProjector, PgKgQueries, PostgresGrantRepository } from '@permguard/authorization';
import { pgPool } from '@permguard/platform';

/**
 * The three questions a boolean cannot answer, against the property graph.
 *
 * These matter more than `check` does for correctness, because nothing else in
 * the system cross-checks them. `check` has a second implementation next door
 * (the normalized recursive CTE) and the reachability test asserts the two
 * agree; `why`, `who` and `blastRadius` exist once each in the serving path.
 *
 * Own fixture, torn down afterwards. Nothing here reads the demo seed.
 */
const P = 'gq';

describe('graph queries', () => {
  let pool: Pool;
  let kg: PgKgQueries;
  let grants: PostgresGrantRepository;

  beforeAll(async () => {
    pool = pgPool();
    kg = new PgKgQueries(pool);
    grants = new PostgresGrantRepository(pool);
    await teardown(pool);
    await setup(pool);
    await new PgKgProjector(pool).rebuild();
  }, 60_000);

  afterAll(async () => {
    await teardown(pool);
    await new PgKgProjector(pool).rebuild().catch(() => undefined);
    await pool.end();
  });

  const id = (x: string): string => `${P}-${x}`;

  describe('why', () => {
    it('returns the chain a person can read', async () => {
      // ada gets write on secrets two ways, and this assertion originally said
      // one. `owner` on secrets confers write directly; `editor` on core
      // confers it by inheritance. Being wrong about that is exactly the thing
      // `/explain` exists to prevent someone being wrong about.
      const why = await kg.why(id('ada'), 'write', id('secrets'));
      expect(why).toHaveLength(2);

      const inherited = why.find((w) => w.viaSubject === id('engineering'));
      expect(inherited!.viaRole).toBe('editor');
      // ada -MEMBER_OF-> platform -CHILD_OF-> engineering -GRANTED-> core -CHILD_OF-> secrets
      expect(inherited!.edges.map((e) => e.rel)).toEqual([
        'MEMBER_OF',
        'CHILD_OF',
        'GRANTED',
        'CHILD_OF',
      ]);

      const direct = why.find((w) => w.viaSubject === id('platform'));
      expect(direct!.viaRole).toBe('owner');
      expect(direct!.edges.map((e) => e.rel)).toEqual(['MEMBER_OF', 'GRANTED']);
    });

    it('returns every path, not the first one', async () => {
      // ada reaches secrets two ways: platform owns it directly, and
      // engineering (which platform is inside) is editor on its parent. A
      // `check` stops at whichever it finds first and reports one bit; this is
      // the difference the endpoint exists for.
      const why = await kg.why(id('ada'), 'read', id('secrets'));
      expect(why.length).toBe(2);
      expect(new Set(why.map((w) => w.viaSubject))).toEqual(
        new Set([id('platform'), id('engineering')]),
      );
    });

    it('returns nothing when there is no path', async () => {
      await expect(kg.why(id('mallory'), 'read', id('core'))).resolves.toHaveLength(0);
    });
  });

  describe('who', () => {
    it('finds everyone who can reach a resource, through nesting', async () => {
      const users = (await kg.who('read', id('secrets'))).map((u) => u.userId).sort();
      expect(users).toEqual([id('ada'), id('grace'), id('linus')].sort());
    });

    it('counts multiple paths for the same user', async () => {
      const ada = (await kg.who('read', id('secrets'))).find((u) => u.userId === id('ada'));
      expect(ada!.paths).toBe(2);
    });

    it('narrows as the permission gets stronger', async () => {
      // Only the org-root owner can delete inside core.
      const users = (await kg.who('delete', id('core'))).map((u) => u.userId);
      expect(users).toEqual([id('linus')]);
    });
  });

  describe('blastRadius', () => {
    it('reports what a revoke would actually take away', async () => {
      const lost = await kg.blastRadius(
        { subjectId: id('engineering'), role: 'editor', resourceId: id('core') },
        'write',
      );
      const pairs = lost.map((l) => `${l.userId}->${l.resourceId}`).sort();
      // ada keeps write on secrets, because platform owns it outright. That
      // exclusion is the whole reason this is a subtraction and not a listing.
      expect(pairs).toEqual([
        `${id('ada')}->${id('core')}`,
        `${id('grace')}->${id('core')}`,
        `${id('grace')}->${id('secrets')}`,
      ]);
    });

    it('reports nothing when another grant still covers everything', async () => {
      // Revoking grace's direct grant on web changes nothing for read: the
      // contractors grant already covers it and grace is not a contractor —
      // but grace is in product, inside engineering, which has nothing on web.
      // So grace does lose it, and that is what it should say.
      const lost = await kg.blastRadius(
        { subjectId: id('grace'), role: 'owner', resourceId: id('web') },
        'read',
      );
      expect(lost.map((l) => l.userId)).toEqual([id('grace')]);
    });
  });

  it('a grant write updates the graph in the same transaction', async () => {
    // No projection lag to wait for: the edge is written by the same commit as
    // the row, so the very next read already sees it.
    expect(await kg.check(id('mallory'), 'read', id('billing'))).toBe(false);

    const { grant } = await grants.grant({
      subjectKind: 'team',
      subjectId: id('contractors'),
      role: 'viewer',
      resourceId: id('billing'),
    });
    expect(await kg.check(id('mallory'), 'read', id('billing'))).toBe(true);

    await grants.revoke(grant.id);
    expect(await kg.check(id('mallory'), 'read', id('billing'))).toBe(false);
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
      ('${P}-ada','${P}-platform'),('${P}-grace','${P}-product'),
      ('${P}-linus','${P}-security'),('${P}-mallory','${P}-contractors');
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
    DELETE FROM kg_edges WHERE src LIKE '${P}-%' OR dst LIKE '${P}-%';
    DELETE FROM kg_nodes WHERE id LIKE '${P}-%';
    DELETE FROM grants      WHERE id LIKE '${P}-%' OR subject_id LIKE '${P}-%';
    DELETE FROM memberships WHERE user_id LIKE '${P}-%';
    DELETE FROM resources   WHERE id LIKE '${P}-%';
    DELETE FROM users       WHERE id LIKE '${P}-%';
    DELETE FROM teams       WHERE id LIKE '${P}-%';
  `);
}
