import type { Pool } from 'pg';

/**
 * Builds the property graph from the normalized tables.
 *
 * The normalized schema stays the source of truth — `grants` is what a write
 * touches and what the transaction covers. `kg_nodes` / `kg_edges` are a
 * projection of it in graph shape, exactly as the Neo4j copy is, so that the
 * comparison in ADR-0007 is between two graph stores rather than between a
 * graph store and a schema built for a different question.
 *
 * Both projections are rebuilt from the same source by the same call, which is
 * the only way the benchmark's agreement assertion can mean anything.
 */
export class PgKgProjector {
  constructor(private readonly pool: Pool) {}

  async rebuild(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Truncate rather than diff: this is a projection, it is rebuilt from
      // scratch, and a partial rebuild that silently kept a stale edge would
      // corrupt every measurement taken afterwards.
      await client.query('TRUNCATE kg_edges, kg_nodes CASCADE');

      await client.query(`
        INSERT INTO kg_nodes (id, label)
             SELECT id, 'User'     FROM users
        UNION SELECT id, 'Team'     FROM teams
        UNION SELECT id, 'Resource' FROM resources
      `);

      await client.query(`
        INSERT INTO kg_edges (src, rel, dst, props)
        SELECT user_id, 'MEMBER_OF', team_id, '{}'::jsonb FROM memberships
      `);
      await client.query(`
        INSERT INTO kg_edges (src, rel, dst, props)
        SELECT id, 'CHILD_OF', parent_id, '{}'::jsonb FROM teams WHERE parent_id IS NOT NULL
      `);
      await client.query(`
        INSERT INTO kg_edges (src, rel, dst, props)
        SELECT id, 'CHILD_OF', parent_id, '{}'::jsonb FROM resources WHERE parent_id IS NOT NULL
      `);
      await client.query(`
        INSERT INTO kg_edges (src, rel, dst, props)
        SELECT subject_id, 'GRANTED', resource_id, jsonb_build_object('role', role)
          FROM grants
        ON CONFLICT DO NOTHING
      `);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.pool.query('ANALYZE kg_nodes; ANALYZE kg_edges');
  }

  /** The edge id for a grant, which is what `blastRadius` takes. */
  async edgeIdForGrant(grantId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT e.id::text
         FROM grants g
         JOIN kg_edges e
           ON e.src = g.subject_id
          AND e.dst = g.resource_id
          AND e.rel = 'GRANTED'
          AND e.props->>'role' = g.role
        WHERE g.id = $1`,
      [grantId],
    );
    return rows[0]?.id ?? null;
  }
}
