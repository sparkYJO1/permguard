import type { Driver } from 'neo4j-driver';
import type { Pool } from 'pg';
import type { GrantAddedPayload, GrantRevokedPayload } from '../domain/events';

/**
 * Writes the graph read model.
 *
 * Ordering matters more than anything else in this file. The projector applies
 * the change to Neo4j and only then announces it; cache eviction is chained
 * behind the announcement rather than behind the original event. Wired the
 * obvious way — evict on `GrantRevoked` — a node would drop its cache, take the
 * next request, miss, read a graph that had not applied the revoke yet, and
 * cache the old answer under the *new* generation. The revoke would then be
 * invisible until a TTL expired. ADR-0003.
 */
export class Neo4jProjector {
  constructor(private readonly driver: Driver) {}

  /**
   * Node constraints only. MERGE without them is a full scan per event.
   *
   * There is deliberately **no** index on `GRANTED.role`, and the reason is the
   * most useful thing this repository learned about Neo4j.
   *
   * One was added, in good faith, to match the `(destination, role)` index
   * Postgres has on `kg_edges` — it seemed unfair to give one store a targeted
   * index and not the other. It made the boolean check 35x slower: 47ms with
   * it, 1.34ms without, measured both ways on the same data.
   *
   * The plan says why. With the index the planner chose
   * `DirectedRelationshipIndexSeek` and pulled 175,008 relationships matching
   * the role list, then filtered them against a nine-element subject set it had
   * no cardinality estimate for. Without it, it expands those nine subjects'
   * outgoing edges and touches about one.
   *
   * The lesson generalises: in a graph store adjacency *is* the index, so a
   * property index on a relationship competes with it rather than complementing
   * it. Postgres's equivalent is a compound index on `(dst, role)` that
   * supports the join, which is a different thing wearing a similar name.
   */
  async ensureConstraints(): Promise<void> {
    const statements = [
      'CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
      'CREATE CONSTRAINT team_id IF NOT EXISTS FOR (t:Team) REQUIRE t.id IS UNIQUE',
      'CREATE CONSTRAINT resource_id IF NOT EXISTS FOR (r:Resource) REQUIRE r.id IS UNIQUE',
      'CREATE CONSTRAINT meta_id IF NOT EXISTS FOR (m:Meta) REQUIRE m.id IS UNIQUE',
      'DROP INDEX granted_role IF EXISTS',
    ];
    const session = this.driver.session();
    try {
      for (const s of statements) await session.run(s);
    } finally {
      await session.close();
    }
  }

  /**
   * Replaces the graph with what Postgres currently holds.
   *
   * The `MATCH (n) DETACH DELETE n` is the fix for a real bug. This method used
   * to only MERGE, which meant it added and updated but never removed — a node
   * deleted in Postgres stayed in the graph forever. In the demo that was
   * invisible because the topology only ever grew. In the benchmark it was not:
   * the first shape's users survived into the next shape's run, and the
   * agreement assertion caught the two stores answering `who` differently
   * because one of them was still holding a previous dataset.
   *
   * A projection is rebuilt, not patched. `PgKgProjector.rebuild` truncates for
   * the same reason.
   */
  async syncTopology(pool: Pool): Promise<void> {
    {
      const wipe = this.driver.session();
      try {
        await wipe.run('MATCH (n) DETACH DELETE n');
      } finally {
        await wipe.close();
      }
    }
    const [users, teams, memberships, resources] = await Promise.all([
      pool.query<{ id: string }>('SELECT id FROM users'),
      pool.query<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM teams'),
      pool.query<{ user_id: string; team_id: string }>('SELECT user_id, team_id FROM memberships'),
      pool.query<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM resources'),
    ]);

    const session = this.driver.session();
    try {
      await session.run('UNWIND $rows AS r MERGE (:User {id: r.id})', { rows: users.rows });
      await session.run('UNWIND $rows AS r MERGE (:Team {id: r.id})', { rows: teams.rows });
      await session.run('UNWIND $rows AS r MERGE (:Resource {id: r.id})', { rows: resources.rows });
      await session.run(
        `UNWIND $rows AS r
         MATCH (c:Team {id: r.id}), (p:Team {id: r.parent_id})
         MERGE (c)-[:CHILD_OF]->(p)`,
        { rows: teams.rows.filter((t) => t.parent_id !== null) },
      );
      await session.run(
        `UNWIND $rows AS r
         MATCH (c:Resource {id: r.id}), (p:Resource {id: r.parent_id})
         MERGE (c)-[:CHILD_OF]->(p)`,
        { rows: resources.rows.filter((r) => r.parent_id !== null) },
      );
      await session.run(
        `UNWIND $rows AS r
         MATCH (u:User {id: r.user_id}), (t:Team {id: r.team_id})
         MERGE (u)-[:MEMBER_OF]->(t)`,
        { rows: memberships.rows },
      );
    } finally {
      await session.close();
    }
  }

  /** Replays every grant currently in Postgres. Bootstrap and repair only. */
  async syncGrants(pool: Pool): Promise<void> {
    const { rows } = await pool.query<{
      subject_kind: 'user' | 'team';
      subject_id: string;
      role: string;
      resource_id: string;
    }>('SELECT subject_kind, subject_id, role, resource_id FROM grants');

    const session = this.driver.session();
    try {
      await session.run('MATCH ()-[g:GRANTED]->() DELETE g');
      for (const kind of ['user', 'team'] as const) {
        await session.run(
          `UNWIND $rows AS r
           MATCH (s:${kind === 'user' ? 'User' : 'Team'} {id: r.subject_id})
           MATCH (res:Resource {id: r.resource_id})
           MERGE (s)-[:GRANTED {role: r.role}]->(res)`,
          { rows: rows.filter((r) => r.subject_kind === kind) },
        );
      }
    } finally {
      await session.close();
    }
  }

  async applyGrantAdded(p: GrantAddedPayload): Promise<void> {
    const label = p.subjectKind === 'user' ? 'User' : 'Team';
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (s:${label} {id: $subjectId})
         MERGE (r:Resource {id: $resourceId})
         MERGE (s)-[:GRANTED {role: $role}]->(r)`,
        { subjectId: p.subjectId, resourceId: p.resourceId, role: p.role },
      );
    } finally {
      await session.close();
    }
  }

  async applyGrantRevoked(p: GrantRevokedPayload): Promise<void> {
    const label = p.subjectKind === 'user' ? 'User' : 'Team';
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (s:${label} {id: $subjectId})-[g:GRANTED {role: $role}]->(r:Resource {id: $resourceId})
         DELETE g`,
        { subjectId: p.subjectId, resourceId: p.resourceId, role: p.role },
      );
    } finally {
      await session.close();
    }
  }

  /** The sequence the graph has applied. Read back by `Neo4jReachability`. */
  async setAppliedSeq(seq: number): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MERGE (m:Meta {id: "projection"}) SET m.seq = $seq', { seq });
    } finally {
      await session.close();
    }
  }
}
