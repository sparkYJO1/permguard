import type { CheckQuery, Decision, Hop } from './decision';
import type { Permission, Role } from './roles';

/** The answer a store gives before caching or fallback logic touches it. */
export interface Reach {
  readonly allowed: boolean;
  readonly path?: readonly Hop[];
}

/**
 * A store that can answer reachability.
 *
 * Two implementations exist and only one of them serves traffic. The interface
 * is what made the comparison in `bench/graph-vs-cte.ts` a fair one — both
 * sides run the same call, so the numbers in ADR-0005 are about the stores and
 * not about how each was invoked. It is kept for the same reason the losing
 * implementation is kept: so the measurement that removed a database can be
 * re-run in one command rather than re-argued from memory.
 */
export interface ReachabilityStore {
  readonly name: 'graph' | 'relational';
  /** The write sequence this store's view has applied. */
  appliedSeq(): Promise<number>;
  check(q: CheckQuery): Promise<Reach>;
  /** Every resource and edge, for the visualiser. Not on the hot path. */
  close?(): Promise<void>;
}

export interface GrantInput {
  readonly subjectKind: 'user' | 'team';
  readonly subjectId: string;
  readonly role: Role;
  readonly resourceId: string;
}

export interface GrantRecord extends GrantInput {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * Writes. Every method here commits the row and its domain event in one
 * transaction — that is what `nestjs-outbox` is doing in the implementation,
 * and it is why a revoke cannot land without the event that invalidates it.
 */
export interface GrantRepository {
  grant(input: GrantInput): Promise<{ grant: GrantRecord; seq: number }>;
  revoke(grantId: string): Promise<{ seq: number; revoked: GrantRecord | null }>;
  list(): Promise<readonly GrantRecord[]>;
  /** Highest write sequence committed. The staleness comparison uses it. */
  currentSeq(): Promise<number>;
}

/** Read side of the decision cache. Implementations are L1 and L2. */
export interface DecisionCache {
  readonly tier: 'l1' | 'l2';
  get(key: string): Promise<Decision | undefined>;
  set(key: string, decision: Decision): Promise<void>;
}

export interface GenerationSource {
  /** Current generation as this node believes it to be. Never blocks. */
  current(): number;
  /** Authoritative read. Used by the TTL backstop, not the hot path. */
  refresh(): Promise<number>;
}

export type { CheckQuery, Decision, Permission, Role };
