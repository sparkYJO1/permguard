import { decisionKey, denied, type CheckQuery, type Decision, type Hop } from '../domain/decision';
import type { DecisionCache, GenerationSource, ReachabilityStore } from '../domain/ports';

export interface DecisionServiceDeps {
  /** In-process, per node. Fast and small. */
  readonly l1: DecisionCache;
  /** Shared across nodes. Survives a node restart. */
  readonly l2: DecisionCache;
  readonly generation: GenerationSource;
  /**
   * Where a decision comes from when neither cache has it.
   *
   * There is exactly one, and it is Postgres. An earlier design had two — a
   * graph read model in front, a recursive CTE behind it as a fallback — and
   * the fallback turned out to be faster than the thing it was backing up at
   * every shape an organisation actually produces. ADR-0005 has the numbers and
   * `bench/graph-vs-cte.ts` re-runs them.
   */
  readonly store: ReachabilityStore;
  readonly onEvent?: (e: { kind: string; detail?: string }) => void;
}

/**
 * The check, in the order it actually happens.
 *
 * The generation is read once at the top and threaded through the key. That is
 * the whole invalidation mechanism: a node that has learned generation G+1
 * cannot construct a key that hits anything written under G, so every decision
 * computed before the change becomes unreachable at the instant the node learns
 * the number — not when a TTL expires, and not when an eviction loop gets round
 * to the key.
 *
 * The window this repository measures is therefore exactly one thing: how long
 * it takes a node to learn the number.
 */
export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  async check(q: CheckQuery): Promise<Decision> {
    const generation = this.deps.generation.current();
    const key = decisionKey(q, generation);

    const l1 = await this.deps.l1.get(key).catch(() => undefined);
    if (l1) return l1;

    const l2 = await this.deps.l2.get(key).catch(() => undefined);
    if (l2) {
      const promoted = { ...l2, source: 'l2' as const };
      void this.deps.l1.set(key, promoted).catch(() => undefined);
      return promoted;
    }

    const computed = await this.compute(q, generation);

    // A decision that could not be computed is never cached. Caching an
    // `unavailable` deny would turn a transient outage into a persistent one
    // that outlives the outage, which is the failure mode people actually hit.
    if (computed.reason !== 'unavailable') {
      void this.deps.l2.set(key, computed).catch(() => undefined);
      void this.deps.l1.set(key, computed).catch(() => undefined);
    }
    return computed;
  }

  /**
   * Compute, or refuse.
   *
   * There is no third option and that is deliberate. A permission service whose
   * store is unreachable can deny, or it can guess; guessing is how a database
   * outage becomes a data breach. The cost is stated rather than hidden: when
   * Postgres is gone this service returns deny for everything that is not
   * already cached, and the caches keep it partially useful in the meantime.
   * ADR-0002.
   */
  private async compute(q: CheckQuery, generation: number): Promise<Decision> {
    try {
      const reach = await this.deps.store.check(q);
      return reach.allowed
        ? {
            allowed: true,
            reason: 'granted',
            source: this.deps.store.name,
            atSeq: generation,
            path: reach.path as readonly Hop[] | undefined,
          }
        : { allowed: false, reason: 'no-path', source: this.deps.store.name, atSeq: generation };
    } catch (err) {
      this.deps.onEvent?.({ kind: 'store-unavailable', detail: (err as Error).message });
      return denied('unavailable', 'none', generation);
    }
  }
}
