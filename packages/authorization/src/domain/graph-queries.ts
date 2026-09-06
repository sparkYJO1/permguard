import type { Permission, Role } from './roles';

/**
 * The four questions a permission graph gets asked.
 *
 * The first repository this became only ever asked the first one, benchmarked
 * it, and deleted a graph database on the result. That was measuring the
 * cheapest question and deciding on it: `check` can stop at the first path it
 * finds, which is exactly the shape a relational index scan is best at and the
 * shape that wastes a graph traversal.
 *
 * The other three cannot stop early, and two of them run the traversal
 * backwards. They are also the questions real authorization systems actually
 * get asked — "why does this person have access" arrives in every audit, and
 * "who can reach this" is what you need before you delete a team.
 */
export interface PathEdge {
  readonly rel: 'MEMBER_OF' | 'CHILD_OF' | 'GRANTED';
  readonly from: string;
  readonly to: string;
  readonly role?: Role;
}

/** One complete reason a user has a permission. There can be many. */
export interface Explanation {
  readonly edges: readonly PathEdge[];
  /** The grant at the end of the chain. */
  readonly viaRole: Role;
  readonly viaSubject: string;
  readonly viaResource: string;
}

export interface Reachable {
  readonly userId: string;
  /** How many distinct paths reach it. One user can qualify several ways. */
  readonly paths: number;
}

export interface LostAccess {
  readonly userId: string;
  readonly resourceId: string;
}

/**
 * A grant addressed by what it means rather than by a row id.
 *
 * The two engines store edges under completely different identifiers — a
 * bigserial here, an `elementId()` there — and passing either one across this
 * interface would make the benchmark compare two different questions. The
 * logical triple is the only address both can resolve.
 */
export interface GrantRef {
  readonly subjectId: string;
  readonly role: Role;
  readonly resourceId: string;
}

export interface GraphQueries {
  readonly engine: 'pg-kg' | 'neo4j';

  /** Q1 — can this user do this here? Stops at the first path. */
  check(userId: string, permission: Permission, resourceId: string): Promise<boolean>;

  /**
   * Q2 — *why*? Every path, not the first one.
   *
   * The expensive part is that "every" removes the early exit. A user who is in
   * four nested teams that each hold a grant on an ancestor of the resource has
   * four answers, and an auditor wants all of them.
   */
  why(userId: string, permission: Permission, resourceId: string): Promise<readonly Explanation[]>;

  /**
   * Q3 — who can reach this resource with this permission?
   *
   * The traversal runs backwards: from the resource, up its ancestors, out
   * along every grant, down through every team, to the users. ADR-0001 called
   * this too expensive to run on a revoke and used a blunt cache generation
   * instead. Whether that was true is now a measurement rather than an
   * assumption.
   */
  who(permission: Permission, resourceId: string): Promise<readonly Reachable[]>;

  /**
   * Q4 — if this grant disappears, who loses this permission where?
   *
   * Impact analysis before a destructive change. The permission is explicit
   * rather than derived from the grant's role, because "loses access" is
   * ambiguous when a role confers four permissions and another grant still
   * covers two of them.
   *
   * It is Q3 over every resource under the grant, *minus* every pair still
   * reachable by some other grant. That subtraction is what makes it more than
   * a loop, and it is why this is the most expensive of the four.
   */
  blastRadius(grant: GrantRef, permission: Permission): Promise<readonly LostAccess[]>;
}
