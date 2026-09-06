import type { Permission, Role } from './roles';

/** One edge of the explanation the UI draws. */
export type Hop =
  | { kind: 'member-of'; from: string; to: string }
  | { kind: 'team-parent'; from: string; to: string }
  | { kind: 'granted'; subject: string; role: Role; resource: string }
  | { kind: 'resource-parent'; from: string; to: string };

/** Where the answer came from. Reported on the wire — see ADR-0004. */
export type DecisionSource = 'l1' | 'l2' | 'graph' | 'relational' | 'none';

export type DenyReason =
  | 'no-path'
  /** Both stores were unreachable. Fail closed. See ADR-0002. */
  | 'unavailable';

export interface Decision {
  readonly allowed: boolean;
  readonly reason: 'granted' | DenyReason;
  readonly source: DecisionSource;
  /** The write sequence the answer reflects. Lets a client detect staleness. */
  readonly atSeq: number;
  /** Populated on allow, and only by the stores — caches replay it verbatim. */
  readonly path?: readonly Hop[];
}

export interface CheckQuery {
  readonly userId: string;
  readonly permission: Permission;
  readonly resourceId: string;
}

/**
 * The cache key.
 *
 * The generation is part of the key rather than something eviction has to hunt
 * down. A grant change bumps one counter, and every decision computed under the
 * old counter becomes unreachable in the same instant on every node that has
 * learned the new value — no key enumeration, no reverse traversal.
 *
 * The reverse traversal is the thing being avoided. Evicting precisely would
 * mean answering "which users could reach this resource *before* the change",
 * which is the check query run backwards over a graph that no longer exists.
 * ADR-0001 has the cost of choosing the blunt instrument instead.
 *
 * Derived in one place because L1, L2 and the eviction path must agree on it.
 */
export const decisionKey = (q: CheckQuery, generation: number): string =>
  `pg:d:g${generation}:${q.userId}:${q.permission}:${q.resourceId}`;

export const denied = (reason: DenyReason, source: DecisionSource, atSeq: number): Decision => ({
  allowed: false,
  reason,
  source,
  atSeq,
});
