import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { enqueue } from 'nestjs-outbox';
import { PostgresGrantRepository } from '@permguard/authorization';
import { TOPIC } from '@permguard/shared-kernel';
import { pgPool } from '@permguard/platform';

/**
 * The property `nestjs-outbox` exists to provide, asserted here rather than
 * trusted.
 *
 * A revoke that commits without its event is a user who keeps their access
 * until someone notices. An event that publishes without its revoke committing
 * is a cache denying something the database still allows. The only way to have
 * neither is for both to be one transaction, and the only way to know that is
 * still true after a refactor is a test that rolls one back.
 */
describe('grant writes and their events are one transaction', () => {
  let pool: Pool;
  let repo: PostgresGrantRepository;

  beforeAll(async () => {
    pool = pgPool();
    repo = new PostgresGrantRepository(pool);
    await pool.query(
      `INSERT INTO resources (id, kind, parent_id) VALUES ('atomicity-test','repo',NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO users (id, display_name) VALUES ('atomicity-user','t') ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM grants WHERE resource_id = 'atomicity-test'`);
    await pool.query(`DELETE FROM outbox WHERE key = 'atomicity-test'`);
    await pool.query(`DELETE FROM resources WHERE id = 'atomicity-test'`);
    await pool.query(`DELETE FROM users WHERE id = 'atomicity-user'`);
    await pool.end();
  });

  it('a grant and its event land together', async () => {
    const before = await outboxCount(pool);
    const { grant } = await repo.grant({
      subjectKind: 'user',
      subjectId: 'atomicity-user',
      role: 'viewer',
      resourceId: 'atomicity-test',
    });

    expect(await outboxCount(pool)).toBe(before + 1);
    const { rows } = await pool.query<{ value: { type: string } }>(
      `SELECT value FROM outbox WHERE key = 'atomicity-test' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.value.type).toBe('GrantAdded');
    expect(grant.id).toBeTruthy();
  });

  it('a revoke and its event land together', async () => {
    const grants = await repo.list();
    const target = grants.find((g) => g.resourceId === 'atomicity-test');
    expect(target).toBeDefined();

    const before = await outboxCount(pool);
    await repo.revoke(target!.id);

    expect(await outboxCount(pool)).toBe(before + 1);
    const { rows } = await pool.query<{ value: { type: string } }>(
      `SELECT value FROM outbox WHERE key = 'atomicity-test' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.value.type).toBe('GrantRevoked');
  });

  it('rolling back loses the row and the event together', async () => {
    const beforeGrants = await grantCount(pool);
    const beforeOutbox = await outboxCount(pool);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO grants (id, subject_kind, subject_id, role, resource_id)
         VALUES ('rollback-me','user','atomicity-user','owner','atomicity-test')`,
      );
      await enqueue(client, {
        topic: TOPIC.authorization,
        key: 'atomicity-test',
        value: { type: 'GrantAdded', occurredAt: new Date().toISOString(), payload: {} },
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await grantCount(pool)).toBe(beforeGrants);
    expect(await outboxCount(pool)).toBe(beforeOutbox);
  });

  it('enqueue refuses a client with no transaction open', async () => {
    // The type system cannot tell these two clients apart — this is the check
    // that can. Without it, a caller who forgot `BEGIN` would get an event
    // published whether or not the business write survived.
    const client = await pool.connect();
    try {
      await expect(
        enqueue(client, { topic: TOPIC.authorization, key: 'x', value: {} }),
      ).rejects.toThrow(/must be called inside a transaction/);
    } finally {
      client.release();
    }
  });
});

async function outboxCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox');
  return rows[0]!.n;
}

async function grantCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM grants');
  return rows[0]!.n;
}
