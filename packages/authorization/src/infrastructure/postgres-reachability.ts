import type { Pool } from 'pg';
import { rolesGranting } from '../domain/roles';
import type { CheckQuery } from '../domain/decision';
import type { Reach, ReachabilityStore } from '../domain/ports';

/**
 * Reachability as one recursive CTE.
 *
 * This is the honest competitor to the Cypher implementation, not a strawman
 * kept around to lose. The two CTE arms are the two dimensions the permission
 * model inherits along — teams upward, resources upward — and the join at the
 * bottom is the grant that connects them. Both arms are indexed
 * (`memberships_user_idx`, `teams_parent_idx`, `resources_parent_idx`,
 * `grants_resource_role_idx`), and `bench/graph-vs-cte.ts` measures it against
 * Neo4j on the same generated data.
 *
 * It is also the availability story: when Neo4j is unreachable, this is what
 * answers, and the answer is correct because Postgres is where the grants are.
 */
export class PostgresReachability implements ReachabilityStore {
  readonly name = 'relational' as const;

  constructor(private readonly pool: Pool) {}

  async appliedSeq(): Promise<number> {
    // Trivially current: this store reads the write side directly. The method
    // exists because both stores implement the same interface, and answering
    // honestly here is what makes the interface not a lie.
    const { rows } = await this.pool.query<{ seq: string }>(
      `SELECT COALESCE(
         pg_sequence_last_value(pg_get_serial_sequence('outbox', 'id')::regclass),
         0
       )::text AS seq`,
    );
    return Number(rows[0]?.seq ?? 0);
  }

  async check(q: CheckQuery): Promise<Reach> {
    const roles = rolesGranting(q.permission);
    const { rows } = await this.pool.query<{
      id: string;
      subject_kind: 'user' | 'team';
      subject_id: string;
      role: string;
      resource_id: string;
    }>(SQL, [q.userId, roles as unknown as string[], q.resourceId]);

    const hit = rows[0];
    if (!hit) return { allowed: false };
    return {
      allowed: true,
      path: [
        {
          kind: 'granted',
          subject: hit.subject_id,
          role: hit.role as never,
          resource: hit.resource_id,
        },
      ],
    };
  }
}

const SQL = `
WITH RECURSIVE
-- Every team the user is in, plus every team those sit inside, transitively.
user_teams(team_id) AS (
  SELECT m.team_id FROM memberships m WHERE m.user_id = $1
  UNION
  SELECT t.parent_id
    FROM user_teams ut
    JOIN teams t ON t.id = ut.team_id
   WHERE t.parent_id IS NOT NULL
),
-- The resource and every ancestor of it. A grant on an ancestor is inherited.
resource_chain(resource_id) AS (
  SELECT $3::text
  UNION
  SELECT r.parent_id
    FROM resource_chain rc
    JOIN resources r ON r.id = rc.resource_id
   WHERE r.parent_id IS NOT NULL
)
SELECT g.id, g.subject_kind, g.subject_id, g.role, g.resource_id
  FROM grants g
 WHERE g.role = ANY($2::text[])
   AND g.resource_id IN (SELECT resource_id FROM resource_chain)
   AND (
        (g.subject_kind = 'user' AND g.subject_id = $1)
     OR (g.subject_kind = 'team' AND g.subject_id IN (SELECT team_id FROM user_teams))
   )
 LIMIT 1
`;

export { SQL as REACHABILITY_SQL };
