import type { Redis } from 'ioredis';
import type { Decision } from '../domain/decision';
import type { DecisionCache } from '../domain/ports';

/**
 * L1 — in process, per node.
 *
 * Bounded, because an unbounded decision cache on a permission service is a
 * memory leak with a security flavour: the entries nobody will ask for again
 * are exactly the ones left over from the previous generation.
 *
 * Entries are never invalidated by this class. They fall out of use when the
 * generation moves, and out of memory when they reach the front of the queue.
 * That separation is the point — eviction correctness does not depend on the
 * cache noticing anything.
 */
export class MemoryDecisionCache implements DecisionCache {
  readonly tier = 'l1' as const;
  private readonly entries = new Map<string, { decision: Decision; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 50_000,
    private readonly ttlMs = 60_000,
  ) {}

  async get(key: string): Promise<Decision | undefined> {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...hit.decision, source: 'l1' };
  }

  async set(key: string, decision: Decision): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      // Insertion order. Cheap, and good enough for a cache whose contents go
      // cold in one step anyway.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { decision, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * L2 — shared. A node that restarts finds the cluster's answers already there,
 * which matters because a cold node otherwise sends its whole first second of
 * traffic to Neo4j.
 */
export class RedisDecisionCache implements DecisionCache {
  readonly tier = 'l2' as const;

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 300,
  ) {}

  async get(key: string): Promise<Decision | undefined> {
    const raw = await this.redis.get(key);
    if (raw === null) return undefined;
    try {
      return { ...(JSON.parse(raw) as Decision), source: 'l2' };
    } catch {
      // A corrupt entry is deleted and recomputed rather than served.
      await this.redis.del(key).catch(() => undefined);
      return undefined;
    }
  }

  async set(key: string, decision: Decision): Promise<void> {
    await this.redis.set(key, JSON.stringify(decision), 'EX', this.ttlSeconds);
  }
}
