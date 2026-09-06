import type {
  Explanation,
  GrantRef,
  GraphQueries,
  LostAccess,
  Reachable,
} from '../domain/graph-queries';
import type { Permission } from '../domain/roles';

export interface GraphServiceDeps {
  /**
   * Faster at every traversal, and its lead grows with the graph. ADR-0007.
   * It is a projection, so it can be behind by the invalidation window.
   */
  readonly primary: GraphQueries;
  /**
   * The property graph inside Postgres. Slower on the traversals but written in
   * the same transaction as the grant, so it is never stale.
   */
  readonly fallback: GraphQueries;
  readonly onEvent?: (e: { kind: string; detail?: string }) => void;
}

export interface GraphAnswer<T> {
  readonly result: T;
  readonly engine: GraphQueries['engine'];
  /** True when the answer came from the store that cannot be behind. */
  readonly authoritative: boolean;
}

/**
 * Traversals, with a fallback that is finally worth having.
 *
 * An earlier version of this repository had a graph store in front of a
 * relational one and could not justify it: the relational side won every
 * benchmark, so the "fallback" was faster than the thing it was backing up and
 * the whole arrangement was theatre. It was deleted.
 *
 * This is the same shape with the measurement pointing the other way. Neo4j is
 * primary because it wins all three traversals and wins by more as the graph
 * grows; the Postgres property graph is behind it because it is written in the
 * grant's own transaction and therefore cannot be stale.
 *
 * Which one answered is reported on every response rather than hidden, because
 * the two differ in freshness and a caller comparing two answers deserves to
 * know which one it got.
 */
export class GraphService {
  constructor(private readonly deps: GraphServiceDeps) {}

  why(
    userId: string,
    permission: Permission,
    resourceId: string,
  ): Promise<GraphAnswer<readonly Explanation[]>> {
    return this.run((q) => q.why(userId, permission, resourceId));
  }

  who(permission: Permission, resourceId: string): Promise<GraphAnswer<readonly Reachable[]>> {
    return this.run((q) => q.who(permission, resourceId));
  }

  /**
   * Impact analysis always uses the authoritative store.
   *
   * This is the one traversal whose answer is acted on immediately — someone is
   * about to revoke a grant and wants to know what breaks. Answering it from a
   * projection that might be a few tens of milliseconds behind means answering
   * a question about a graph that is no longer the one being changed. The
   * slower store is the correct one here, and ADR-0007 says so rather than
   * leaving it to a comment.
   */
  async blastRadius(
    grant: GrantRef,
    permission: Permission,
  ): Promise<GraphAnswer<readonly LostAccess[]>> {
    return {
      result: await this.deps.fallback.blastRadius(grant, permission),
      engine: this.deps.fallback.engine,
      authoritative: true,
    };
  }

  private async run<T>(fn: (q: GraphQueries) => Promise<T>): Promise<GraphAnswer<T>> {
    try {
      return { result: await fn(this.deps.primary), engine: this.deps.primary.engine, authoritative: false };
    } catch (err) {
      this.deps.onEvent?.({ kind: 'graph-primary-unavailable', detail: (err as Error).message });
      return { result: await fn(this.deps.fallback), engine: this.deps.fallback.engine, authoritative: true };
    }
  }
}
