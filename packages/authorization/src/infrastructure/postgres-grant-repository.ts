import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { enqueue } from 'nestjs-outbox';
import { TOPIC } from '@permguard/shared-kernel';
import type { GrantInput, GrantRecord, GrantRepository } from '../domain/ports';

/**
 * The write side, and the reason `nestjs-outbox` is a dependency here rather
 * than a link in the README.
 *
 * A revoke that commits without its event is a user who keeps their access
 * until someone notices. An event published without its revoke committing is a
 * cache that denies something the database still allows. Both are wrong, and
 * the only way to have neither is for the row and the message to be the same
 * transaction — which is the entire content of the outbox pattern and the
 * entire reason that library exists.
 *
 * `enqueue` takes this method's transaction client. It does not open its own,
 * and it refuses a client with no `BEGIN` on it, so the guarantee cannot be
 * lost by wiring this up carelessly.
 *
 * The graph edge is written in that same transaction, and that is the strongest
 * argument this repository found for keeping the knowledge graph in Postgres
 * rather than beside it. An external graph store is necessarily a projection:
 * it is updated after the write commits, so there is a window where the two
 * disagree, and closing that window costs an ordering constraint on cache
 * invalidation (ADR-0003 has the bug that constraint exists to prevent). A
 * graph in the same database has no window, because it is the same commit.
 */
export class PostgresGrantRepository implements GrantRepository {
  constructor(private readonly pool: Pool) {}

  async grant(input: GrantInput): Promise<{ grant: GrantRecord; seq: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const { rows } = await client.query<{ created_at: string }>(
        `INSERT INTO grants (id, subject_kind, subject_id, role, resource_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subject_kind, subject_id, role, resource_id) DO NOTHING
         RETURNING created_at`,
        [id, input.subjectKind, input.subjectId, input.role, input.resourceId],
      );

      // Already granted. Nothing changed, so nothing is published — publishing
      // here would bump the generation and cold-start every cache in the
      // cluster for a write that was a no-op.
      if (rows.length === 0) {
        await client.query('COMMIT');
        const existing = await this.find(input);
        return { grant: existing!, seq: await this.currentSeq() };
      }

      // The nodes are normally already there — `PgKgProjector.rebuild` puts
      // them there at boot. Ensuring them here means a grant naming an entity
      // created since the last rebuild writes an edge instead of failing a
      // foreign key, which is the difference between a self-healing projection
      // and one that needs a restart.
      await client.query(
        `INSERT INTO kg_nodes (id, label) VALUES ($1, $2), ($3, 'Resource')
         ON CONFLICT (id) DO NOTHING`,
        [input.subjectId, input.subjectKind === 'user' ? 'User' : 'Team', input.resourceId],
      );
      await client.query(
        `INSERT INTO kg_edges (src, rel, dst, props)
         VALUES ($1, 'GRANTED', $2, jsonb_build_object('role', $3::text))
         ON CONFLICT DO NOTHING`,
        [input.subjectId, input.resourceId, input.role],
      );

      await enqueue(client, {
        topic: TOPIC.authorization,
        key: input.resourceId,
        value: {
          type: 'GrantAdded',
          occurredAt: new Date().toISOString(),
          payload: { grantId: id, ...input },
        },
      });
      const seq = await currentOutboxId(client);
      await client.query('COMMIT');

      return {
        grant: { id, createdAt: rows[0]!.created_at, ...input },
        seq,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async revoke(grantId: string): Promise<{ seq: number; revoked: GrantRecord | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        id: string;
        subject_kind: 'user' | 'team';
        subject_id: string;
        role: string;
        resource_id: string;
        created_at: string;
      }>(`DELETE FROM grants WHERE id = $1 RETURNING *`, [grantId]);

      const row = rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { seq: await this.currentSeq(), revoked: null };
      }

      await client.query(
        `DELETE FROM kg_edges
          WHERE rel = 'GRANTED' AND src = $1 AND dst = $2 AND props->>'role' = $3`,
        [row.subject_id, row.resource_id, row.role],
      );

      await enqueue(client, {
        topic: TOPIC.authorization,
        key: row.resource_id,
        value: {
          type: 'GrantRevoked',
          occurredAt: new Date().toISOString(),
          payload: {
            grantId: row.id,
            subjectKind: row.subject_kind,
            subjectId: row.subject_id,
            role: row.role,
            resourceId: row.resource_id,
          },
        },
      });
      const seq = await currentOutboxId(client);
      await client.query('COMMIT');

      return {
        seq,
        revoked: {
          id: row.id,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          role: row.role as never,
          resourceId: row.resource_id,
          createdAt: row.created_at,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async list(): Promise<readonly GrantRecord[]> {
    const { rows } = await this.pool.query<{
      id: string;
      subject_kind: 'user' | 'team';
      subject_id: string;
      role: string;
      resource_id: string;
      created_at: string;
    }>('SELECT * FROM grants ORDER BY created_at');
    return rows.map((r) => ({
      id: r.id,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      role: r.role as never,
      resourceId: r.resource_id,
      createdAt: r.created_at,
    }));
  }

  async currentSeq(): Promise<number> {
    const { rows } = await this.pool.query<{ seq: string }>(
      `SELECT COALESCE(
         pg_sequence_last_value(pg_get_serial_sequence('outbox', 'id')::regclass),
         0
       )::text AS seq`,
    );
    return Number(rows[0]?.seq ?? 0);
  }

  private async find(input: GrantInput): Promise<GrantRecord | null> {
    const { rows } = await this.pool.query<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM grants
        WHERE subject_kind = $1 AND subject_id = $2 AND role = $3 AND resource_id = $4`,
      [input.subjectKind, input.subjectId, input.role, input.resourceId],
    );
    const row = rows[0];
    return row ? { id: row.id, createdAt: row.created_at, ...input } : null;
  }
}

/**
 * The id `enqueue` just wrote. `currval` is session-local and exact, which
 * `max(id)` is not once a second writer exists.
 */
async function currentOutboxId(client: {
  query: (sql: string) => Promise<{ rows: Array<{ seq: string }> }>;
}): Promise<number> {
  const { rows } = await client.query(
    "SELECT currval(pg_get_serial_sequence('outbox','id'))::text AS seq",
  );
  return Number(rows[0]?.seq ?? 0);
}
