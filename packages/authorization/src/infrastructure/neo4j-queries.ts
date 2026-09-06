import type { Driver } from 'neo4j-driver';
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
 * The same four questions, in Cypher.
 *
 * Read this file next to `pg-kg-queries.ts`. That is the comparison the brief
 * asked for and the one the first version of this repository failed to make:
 * the SQL is 180 lines, this is 60, and the difference is concentrated in the
 * two questions that traverse backwards.
 *
 * Whether that is worth a second database is answered by ADR-0007 with numbers,
 * not by this paragraph. Both engines are held to the same interface so the
 * benchmark calls identical methods, and the benchmark asserts they agree
 * before it times anything.
 */
export class Neo4jQueries implements GraphQueries {
  readonly engine = 'neo4j' as const;

  constructor(
    private readonly driver: Driver,
    private readonly maxDepth = 20,
  ) {}

  async check(userId: string, permission: Permission, resourceId: string): Promise<boolean> {
    const res = await this.run(CHECK(this.maxDepth), {
      userId,
      resourceId,
      roles: rolesGranting(permission) as unknown as string[],
    });
    return res.length > 0;
  }

  async why(
    userId: string,
    permission: Permission,
    resourceId: string,
  ): Promise<readonly Explanation[]> {
    const records = await this.run(WHY(this.maxDepth), {
      userId,
      resourceId,
      roles: rolesGranting(permission) as unknown as string[],
    });

    return records.map((r) => {
      const subjectChain = r.get('subjectChain') as string[];
      const resourceChain = r.get('resourceChain') as string[];
      const viaSubject = String(r.get('viaSubject'));
      const viaResource = String(r.get('viaResource'));
      const viaRole = String(r.get('viaRole')) as Role;

      const edges: PathEdge[] = [];
      for (let i = 0; i < subjectChain.length - 1; i += 1) {
        edges.push({
          // The first hop out of a user is MEMBER_OF; every hop after it is a
          // team sitting inside a team.
          rel: i === 0 ? 'MEMBER_OF' : 'CHILD_OF',
          from: subjectChain[i]!,
          to: subjectChain[i + 1]!,
        });
      }
      edges.push({ rel: 'GRANTED', from: viaSubject, to: viaResource, role: viaRole });
      for (let i = resourceChain.length - 1; i > 0; i -= 1) {
        edges.push({ rel: 'CHILD_OF', from: resourceChain[i - 1]!, to: resourceChain[i]! });
      }

      return { edges, viaRole, viaSubject, viaResource };
    });
  }

  async who(permission: Permission, resourceId: string): Promise<readonly Reachable[]> {
    const records = await this.run(WHO(this.maxDepth), {
      resourceId,
      roles: rolesGranting(permission) as unknown as string[],
    });
    return records.map((r) => ({
      userId: String(r.get('userId')),
      paths: Number(r.get('paths')),
    }));
  }

  async blastRadius(grant: GrantRef, permission: Permission): Promise<readonly LostAccess[]> {
    const records = await this.run(BLAST(this.maxDepth), {
      subjectId: grant.subjectId,
      role: grant.role,
      resourceId: grant.resourceId,
      roles: rolesGranting(permission) as unknown as string[],
    });
    return records.map((r) => ({
      userId: String(r.get('userId')),
      resourceId: String(r.get('resourceId')),
    }));
  }

  private async run(cypher: string, params: Record<string, unknown>) {
    const session = this.driver.session({ defaultAccessMode: 'READ' });
    try {
      return (await session.run(cypher, params)).records;
    } finally {
      await session.close();
    }
  }
}

/**
 * Every one of these starts from the *user*, not the resource, and that single
 * choice is worth more than everything else in this file.
 *
 * `bench/cypher-direction.ts` measures it: on the largest shape, the same
 * boolean check is 142ms driven from the resource and 2.3ms driven from the
 * subject — 60x, same engine, same data, same answer. The resource end of this
 * graph has hundreds of incoming GRANTED edges per node and the user end has a
 * handful of outgoing ones, and index-free adjacency means Neo4j walks whatever
 * you point it at.
 *
 * The first version of this file pointed it at the wrong end and produced a
 * benchmark that made Neo4j look 60x slower than Postgres. That was not a
 * finding about Neo4j. Postgres never had to make this choice: the SQL next
 * door builds both closures and lets the planner pick which to drive from,
 * which is a genuine difference between the two — but it is a difference in
 * where the expertise has to live, not in what the engine can do.
 */
const SUBJECTS = (d: number) => `
MATCH (u:User {id: $userId})
OPTIONAL MATCH (u)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(t:Team)
WITH u, collect(DISTINCT t) AS teams`;

const CHECK = (d: number) => `
${SUBJECTS(d)}
UNWIND (teams + [u]) AS s
MATCH (s)-[g:GRANTED]->(anc:Resource)
WHERE g.role IN $roles
MATCH (r:Resource {id: $resourceId})-[:CHILD_OF*0..${d}]->(anc)
RETURN s.id AS subjectId
LIMIT 1`;

// `why` is the same walk with the LIMIT removed, returning the paths it
// crossed. The SQL equivalent accumulates the chain by hand in two recursive
// CTEs and is four times longer; this is the expressiveness claim, stated as
// something a reader can check rather than as an adjective.
const WHY = (d: number) => `
MATCH (u:User {id: $userId})
OPTIONAL MATCH sp = (u)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(t:Team)
WITH u, collect({s: t, p: sp}) AS teamPaths
UNWIND (teamPaths + [{s: u, p: null}]) AS cand
WITH cand.s AS s, cand.p AS sp
WHERE s IS NOT NULL
MATCH (s)-[g:GRANTED]->(anc:Resource)
WHERE g.role IN $roles
MATCH rp = (r:Resource {id: $resourceId})-[:CHILD_OF*0..${d}]->(anc)
RETURN CASE WHEN sp IS NULL THEN [] ELSE [n IN nodes(sp) | n.id] END AS subjectChain,
       [n IN nodes(rp) | n.id] AS resourceChain,
       s.id AS viaSubject, g.role AS viaRole, anc.id AS viaResource`;

// Q3 is the one question that genuinely has to start at the resource — "who can
// reach this" names the resource and asks for the users. The fan-in is the
// question, not a bad plan.
const WHO = (d: number) => `
MATCH (r:Resource {id: $resourceId})-[:CHILD_OF*0..${d}]->(anc:Resource)<-[g:GRANTED]-(s)
WHERE g.role IN $roles
OPTIONAL MATCH (m:User)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(s)
WITH coalesce(m, CASE WHEN s:User THEN s END) AS u
WHERE u IS NOT NULL
RETURN u.id AS userId, count(*) AS paths
ORDER BY userId`;

/**
 * Q4 was rewritten three times and every rewrite fixed my Cypher rather than
 * discovering anything about Neo4j: a bare `MATCH (u:User)` that scanned every
 * user, then a per-pair reachability test where the SQL used one set, and
 * finally the direction of the inner walk. The still-reachable set is computed
 * once, driven from the candidate users, and subtracted.
 */
const BLAST = (d: number) => `
MATCH (subject {id: $subjectId})-[target:GRANTED {role: $role}]->(root:Resource {id: $resourceId})
MATCH (res:Resource)-[:CHILD_OF*0..${d}]->(root)
OPTIONAL MATCH (m:User)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(subject)
WITH target,
     collect(DISTINCT res) AS candidateRes,
     collect(DISTINCT coalesce(m, CASE WHEN subject:User THEN subject END)) AS rawUsers
WITH target, candidateRes, [x IN rawUsers WHERE x IS NOT NULL] AS candidateUsers
CALL {
  WITH target, candidateUsers, candidateRes
  UNWIND candidateUsers AS u2
  OPTIONAL MATCH (u2)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(t2:Team)
  WITH target, candidateRes, u2, collect(DISTINCT t2) AS ts
  UNWIND (ts + [u2]) AS s2
  MATCH (s2)-[other:GRANTED]->(anc:Resource)
  WHERE elementId(other) <> elementId(target) AND other.role IN $roles
  MATCH (r2:Resource)-[:CHILD_OF*0..${d}]->(anc)
  WHERE r2 IN candidateRes
  RETURN collect(DISTINCT u2.id + '|' + r2.id) AS still
}
UNWIND candidateUsers AS u
UNWIND candidateRes AS res
WITH u, res, still
WHERE NOT (u.id + '|' + res.id) IN still
RETURN u.id AS userId, res.id AS resourceId
ORDER BY userId, resourceId`;

export { CHECK as CYPHER_CHECK, WHY as CYPHER_WHY, WHO as CYPHER_WHO, BLAST as CYPHER_BLAST };
