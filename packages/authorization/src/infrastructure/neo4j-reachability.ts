import type { Driver } from 'neo4j-driver';
import { rolesGranting } from '../domain/roles';
import type { CheckQuery, Hop } from '../domain/decision';
import type { Reach, ReachabilityStore } from '../domain/ports';

/**
 * The same question in Cypher.
 *
 * The argument for the graph store is in this one pattern:
 *
 *     (r)-[:CHILD_OF*0..]->(anc)<-[g:GRANTED]-(s)
 *
 * Two variable-length walks and the join between them, written the way the
 * model is drawn on a whiteboard. The recursive CTE next door expresses the
 * same thing in twenty lines of two mutually independent recursions plus a join.
 * Whether that expressiveness is worth an extra store is the question
 * ADR-0005 answers with numbers rather than with this paragraph.
 *
 * The depth bound is deliberate. Unbounded `*` on a cyclic graph is how a
 * permission check becomes an outage, and org charts acquire cycles by
 * accident. `*0..$maxDepth` makes the worst case finite; the seed data and the
 * bench both stay well inside it, and exceeding it fails closed rather than
 * hanging.
 */
export class Neo4jReachability implements ReachabilityStore {
  readonly name = 'graph' as const;

  constructor(
    private readonly driver: Driver,
    private readonly maxDepth = 16,
  ) {}

  async appliedSeq(): Promise<number> {
    const session = this.driver.session();
    try {
      const res = await session.run('MATCH (m:Meta {id: "projection"}) RETURN m.seq AS seq');
      const raw = res.records[0]?.get('seq');
      return raw === null || raw === undefined ? 0 : Number(raw);
    } finally {
      await session.close();
    }
  }

  async check(q: CheckQuery): Promise<Reach> {
    const roles = rolesGranting(q.permission);
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      const res = await session.run(CYPHER(this.maxDepth), {
        userId: q.userId,
        resourceId: q.resourceId,
        roles: roles as unknown as string[],
      });
      const rec = res.records[0];
      if (!rec) return { allowed: false };
      const hop: Hop = {
        kind: 'granted',
        subject: String(rec.get('subjectId')),
        role: String(rec.get('role')) as never,
        resource: String(rec.get('resourceId')),
      };
      return { allowed: true, path: [hop] };
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

/**
 * `roles` arrives as a parameter rather than being written into the query,
 * because the role lattice is defined once in the domain and neither store is
 * allowed a second copy of it.
 */
const CYPHER = (maxDepth: number) => `
MATCH (u:User {id: $userId})
MATCH (r:Resource {id: $resourceId})
MATCH (r)-[:CHILD_OF*0..${maxDepth}]->(anc:Resource)<-[g:GRANTED]-(s)
WHERE g.role IN $roles
  AND (
       s.id = u.id
    OR (s:Team AND EXISTS {
         MATCH (u)-[:MEMBER_OF]->(t:Team)-[:CHILD_OF*0..${maxDepth}]->(s)
       })
  )
RETURN s.id AS subjectId, g.role AS role, anc.id AS resourceId
LIMIT 1
`;

export { CYPHER as REACHABILITY_CYPHER };
