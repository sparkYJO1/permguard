import type { Pool } from 'pg';
import { rolesGranting, type Permission, type Role } from '../domain/roles';
import type {
  Explanation,
  GrantRef,
  GraphQueries,
  LostAccess,
  PathEdge,
  Reachable,
} from '../domain/graph-queries';

/**
 * The four questions, against a property graph stored in Postgres.
 *
 * Every traversal here is a recursive CTE over one generic `kg_edges` table,
 * walking by relationship label — the same walk Cypher does next door, which is
 * the point: the comparison in ADR-0007 is between engines and storage models,
 * not between a schema shaped for the question and one that is not.
 *
 * Depth is bounded on every recursion. An org chart acquires a cycle the first
 * time someone makes two teams each other's parent, and an unbounded `UNION
 * ALL` on a cyclic graph is an outage rather than a wrong answer.
 */
export class PgKgQueries implements GraphQueries {
  readonly engine = 'pg-kg' as const;

  constructor(
    private readonly pool: Pool,
    private readonly maxDepth = 20,
  ) {}

  async check(userId: string, permission: Permission, resourceId: string): Promise<boolean> {
    const { rows } = await this.pool.query(CHECK_SQL, [
      userId,
      rolesGranting(permission) as unknown as string[],
      resourceId,
    ]);
    return rows.length > 0;
  }

  async why(
    userId: string,
    permission: Permission,
    resourceId: string,
  ): Promise<readonly Explanation[]> {
    const { rows } = await this.pool.query<{
      subject_path: PathEdge[];
      resource_path: PathEdge[];
      via_subject: string;
      via_role: string;
      via_resource: string;
    }>(WHY_SQL(this.maxDepth), [
      userId,
      rolesGranting(permission) as unknown as string[],
      resourceId,
    ]);

    return rows.map((r) => ({
      // Subject side walks up to the granted team; resource side walks up to
      // the granted ancestor. Reversing the second puts the whole chain in the
      // order a person reads it: user → team → grant → resource.
      edges: [
        ...r.subject_path,
        {
          rel: 'GRANTED' as const,
          from: r.via_subject,
          to: r.via_resource,
          role: r.via_role as Role,
        },
        ...[...r.resource_path].reverse(),
      ],
      viaRole: r.via_role as Role,
      viaSubject: r.via_subject,
      viaResource: r.via_resource,
    }));
  }

  async who(permission: Permission, resourceId: string): Promise<readonly Reachable[]> {
    const { rows } = await this.pool.query<{ user_id: string; paths: string }>(
      WHO_SQL(this.maxDepth),
      [rolesGranting(permission) as unknown as string[], resourceId],
    );
    return rows.map((r) => ({ userId: r.user_id, paths: Number(r.paths) }));
  }

  async blastRadius(grant: GrantRef, permission: Permission): Promise<readonly LostAccess[]> {
    const { rows } = await this.pool.query<{ user_id: string; resource_id: string }>(BLAST_SQL, [
      grant.subjectId,
      grant.role,
      grant.resourceId,
      rolesGranting(permission) as unknown as string[],
    ]);
    return rows.map((r) => ({ userId: r.user_id, resourceId: r.resource_id }));
  }
}

/**
 * Q1. Two independent walks up — teams from the user, ancestors from the
 * resource — meeting at a GRANTED edge. `LIMIT 1` is what makes this the cheap
 * question: it stops at the first path and never learns whether there were
 * others.
 */
const CHECK_SQL = `
WITH RECURSIVE
subjects(id) AS (
  SELECT $1::text
  UNION
  SELECT e.dst
    FROM subjects s
    JOIN kg_edges e ON e.src = s.id AND e.rel IN ('MEMBER_OF', 'CHILD_OF')
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Team'
),
ancestors(id) AS (
  SELECT $3::text
  UNION
  SELECT e.dst
    FROM ancestors a
    JOIN kg_edges e ON e.src = a.id AND e.rel = 'CHILD_OF'
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Resource'
)
SELECT 1
  FROM kg_edges g
 WHERE g.rel = 'GRANTED'
   AND g.props->>'role' = ANY($2::text[])
   AND g.dst IN (SELECT id FROM ancestors)
   AND g.src IN (SELECT id FROM subjects)
 LIMIT 1
`;

/**
 * Q2. The same two walks, carrying the edges they crossed, and without the
 * early exit. `UNION ALL` rather than `UNION` because two distinct routes to
 * the same team are two distinct explanations, which is exactly what an auditor
 * is asking for.
 */
const WHY_SQL = (maxDepth: number) => `
WITH RECURSIVE
subjects(id, depth, path) AS (
  SELECT $1::text, 0, '[]'::jsonb
  UNION ALL
  SELECT e.dst, s.depth + 1,
         s.path || jsonb_build_object('rel', e.rel, 'from', e.src, 'to', e.dst)
    FROM subjects s
    JOIN kg_edges e ON e.src = s.id AND e.rel IN ('MEMBER_OF', 'CHILD_OF')
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Team'
   WHERE s.depth < ${maxDepth}
),
ancestors(id, depth, path) AS (
  SELECT $3::text, 0, '[]'::jsonb
  UNION ALL
  SELECT e.dst, a.depth + 1,
         a.path || jsonb_build_object('rel', e.rel, 'from', e.src, 'to', e.dst)
    FROM ancestors a
    JOIN kg_edges e ON e.src = a.id AND e.rel = 'CHILD_OF'
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Resource'
   WHERE a.depth < ${maxDepth}
)
SELECT s.path AS subject_path,
       a.path AS resource_path,
       g.src  AS via_subject,
       g.props->>'role' AS via_role,
       g.dst  AS via_resource
  FROM kg_edges g
  JOIN subjects  s ON s.id = g.src
  JOIN ancestors a ON a.id = g.dst
 WHERE g.rel = 'GRANTED'
   AND g.props->>'role' = ANY($2::text[])
`;

/**
 * Q3. The traversal runs backwards.
 *
 * Up from the resource to its ancestors, out along every grant that lands on
 * one, then *down* from each granted subject through the teams inside it to the
 * users. That last leg reads `kg_edges` by `dst`, which is why the reverse
 * index exists and why storing the graph generically is not just tidiness.
 */
const WHO_SQL = (maxDepth: number) => `
WITH RECURSIVE
ancestors(id) AS (
  SELECT $2::text
  UNION
  SELECT e.dst
    FROM ancestors a
    JOIN kg_edges e ON e.src = a.id AND e.rel = 'CHILD_OF'
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Resource'
),
granted(id) AS (
  SELECT g.src
    FROM kg_edges g
   WHERE g.rel = 'GRANTED'
     AND g.props->>'role' = ANY($1::text[])
     AND g.dst IN (SELECT id FROM ancestors)
),
members(id, depth) AS (
  SELECT id, 0 FROM granted
  UNION ALL
  SELECT e.src, m.depth + 1
    FROM members m
    JOIN kg_edges e ON e.dst = m.id AND e.rel IN ('MEMBER_OF', 'CHILD_OF')
   WHERE m.depth < ${maxDepth}
)
SELECT n.id AS user_id, count(*)::text AS paths
  FROM members m
  JOIN kg_nodes n ON n.id = m.id AND n.label = 'User'
 GROUP BY n.id
 ORDER BY n.id
`;

/**
 * Q4. Everything under the grant, minus everything still reachable without it.
 *
 * The subtraction is the expensive half and it is not avoidable: a pair only
 * "loses access" if no *other* grant still covers it, so the second closure has
 * to be computed over the whole candidate space rather than sampled.
 */
const BLAST_SQL = `
WITH RECURSIVE
target AS (
  SELECT id, src, dst
    FROM kg_edges
   WHERE rel = 'GRANTED' AND src = $1::text AND dst = $3::text AND props->>'role' = $2::text
),
descendants(id) AS (
  SELECT dst FROM target
  UNION
  SELECT e.src
    FROM descendants d
    JOIN kg_edges e ON e.dst = d.id AND e.rel = 'CHILD_OF'
    JOIN kg_nodes n ON n.id = e.src AND n.label = 'Resource'
),
holders(id) AS (
  SELECT src FROM target
  UNION
  SELECT e.src
    FROM holders h
    JOIN kg_edges e ON e.dst = h.id AND e.rel IN ('MEMBER_OF', 'CHILD_OF')
),
affected_users AS (
  SELECT h.id FROM holders h JOIN kg_nodes n ON n.id = h.id AND n.label = 'User'
),
subject_closure(user_id, subject_id) AS (
  SELECT id, id FROM affected_users
  UNION
  SELECT sc.user_id, e.dst
    FROM subject_closure sc
    JOIN kg_edges e ON e.src = sc.subject_id AND e.rel IN ('MEMBER_OF', 'CHILD_OF')
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Team'
),
resource_closure(resource_id, ancestor_id) AS (
  SELECT id, id FROM descendants
  UNION
  SELECT rc.resource_id, e.dst
    FROM resource_closure rc
    JOIN kg_edges e ON e.src = rc.ancestor_id AND e.rel = 'CHILD_OF'
    JOIN kg_nodes n ON n.id = e.dst AND n.label = 'Resource'
),
still_allowed AS (
  SELECT DISTINCT sc.user_id, rc.resource_id
    FROM kg_edges g
    JOIN subject_closure  sc ON sc.subject_id  = g.src
    JOIN resource_closure rc ON rc.ancestor_id = g.dst
   WHERE g.rel = 'GRANTED'
     AND g.id <> (SELECT id FROM target)
     AND g.props->>'role' = ANY($4::text[])
)
SELECT u.id AS user_id, d.id AS resource_id
  FROM affected_users u
 CROSS JOIN descendants d
 WHERE NOT EXISTS (
   SELECT 1 FROM still_allowed s WHERE s.user_id = u.id AND s.resource_id = d.id
 )
 ORDER BY u.id, d.id
`;
