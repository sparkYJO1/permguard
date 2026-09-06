/**
 * The envelope every cross-context message travels in.
 *
 * Contexts do not read each other's tables; this is the only thing that crosses
 * a boundary. `seq` is the load-bearing field — it is the outbox id of the write
 * that produced the event, and it is also what every node uses as its cache
 * generation. See ADR-0001.
 *
 * This package is deliberately this small. A shared kernel is the easiest place
 * in a domain-driven codebase for coupling to accumulate, because everything is
 * allowed to import it; keeping it to one file means there is nowhere for that
 * to happen quietly.
 */
export interface DomainEvent<T extends string = string, P = unknown> {
  readonly type: T;
  /** Monotonic per-database write sequence. Ordering and staleness both use it. */
  readonly seq: number;
  readonly occurredAt: string;
  readonly payload: P;
}

export const TOPIC = {
  /** Authorization's outward-facing facts: a grant appeared or disappeared. */
  authorization: 'authorization.events',
} as const;

export type Topic = (typeof TOPIC)[keyof typeof TOPIC];
