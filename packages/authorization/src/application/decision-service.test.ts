import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionService } from './decision-service';
import { decisionKey, type Decision } from '../domain/decision';
import type { DecisionCache, GenerationSource, Reach, ReachabilityStore } from '../domain/ports';

const query = { userId: 'u1', permission: 'read' as const, resourceId: 'r1' };

function memoryCache(tier: 'l1' | 'l2'): DecisionCache & { store: Map<string, Decision> } {
  const store = new Map<string, Decision>();
  return {
    tier,
    store,
    async get(k) {
      return store.get(k);
    },
    async set(k, d) {
      store.set(k, d);
    },
  };
}

function stubStore(name: 'graph' | 'relational', reach: Reach | Error): ReachabilityStore {
  return {
    name,
    appliedSeq: async () => 0,
    check: async () => {
      if (reach instanceof Error) throw reach;
      return reach;
    },
  };
}

function generationAt(value: number): GenerationSource & { set(n: number): void } {
  let current = value;
  return {
    current: () => current,
    refresh: async () => current,
    set: (n) => {
      current = n;
    },
  };
}

describe('DecisionService', () => {
  let l1: ReturnType<typeof memoryCache>;
  let l2: ReturnType<typeof memoryCache>;

  beforeEach(() => {
    l1 = memoryCache('l1');
    l2 = memoryCache('l2');
  });

  it('answers from the graph on a cold cache and fills both tiers', async () => {
    const svc = new DecisionService({
      l1,
      l2,
      generation: generationAt(1),
      store: stubStore('relational', { allowed: true }),
    });

    const d = await svc.check(query);
    expect(d).toMatchObject({ allowed: true, reason: 'granted', source: 'relational' });
    expect(l1.store.size).toBe(1);
    expect(l2.store.size).toBe(1);
  });

  it('serves the second call from L1 without touching a store', async () => {
    const store = stubStore('relational', { allowed: true });
    const spy = vi.spyOn(store, 'check');
    const svc = new DecisionService({ l1, l2, generation: generationAt(1), store });

    await svc.check(query);
    await svc.check(query);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bumping the generation makes a cached allow unreachable', async () => {
    // The whole invalidation story in one test. Nothing is deleted; the old
    // entry is simply no longer addressable, and the fresh computation says no.
    const generation = generationAt(1);
    let allowed = true;
    const store: ReachabilityStore = {
      name: 'relational',
      appliedSeq: async () => 0,
      check: async () => ({ allowed }),
    };
    const svc = new DecisionService({ l1, l2, generation, store });

    expect((await svc.check(query)).allowed).toBe(true);

    allowed = false; // the revoke landed in the store
    expect((await svc.check(query)).allowed).toBe(true); // still cached under gen 1

    generation.set(2); // the node learns the new generation
    expect((await svc.check(query)).allowed).toBe(false);

    // The stale entry is still in memory, and that is fine — it is filed under
    // a key nothing will ask for again.
    expect(l1.store.has(decisionKey(query, 1))).toBe(true);
  });

  it('fails closed when the store is gone', async () => {
    // Not fail-open, not last-known-good. A permission service that cannot
    // reach its store has nothing to say, and saying yes anyway is how an
    // outage becomes an incident. ADR-0002.
    const svc = new DecisionService({
      l1,
      l2,
      generation: generationAt(3),
      store: stubStore('relational', new Error('postgres gone')),
    });

    const d = await svc.check(query);
    expect(d).toMatchObject({ allowed: false, reason: 'unavailable', source: 'none' });
  });

  it('never caches an unavailable deny', async () => {
    // Caching this would outlive the outage that caused it.
    const svc = new DecisionService({
      l1,
      l2,
      generation: generationAt(3),
      store: stubStore('relational', new Error('down')),
    });

    await svc.check(query);
    expect(l1.store.size).toBe(0);
    expect(l2.store.size).toBe(0);
  });

  it('promotes an L2 hit into L1 and labels it', async () => {
    const generation = generationAt(5);
    await l2.set(decisionKey(query, 5), {
      allowed: true,
      reason: 'granted',
      source: 'graph',
      atSeq: 5,
    });
    const store = stubStore('relational', { allowed: false });
    const spy = vi.spyOn(store, 'check');
    const svc = new DecisionService({ l1, l2, generation, store });

    const d = await svc.check(query);
    expect(d).toMatchObject({ allowed: true, source: 'l2' });
    expect(spy).not.toHaveBeenCalled();
    expect(l1.store.size).toBe(1);
  });

  it('survives a cache that throws on read', async () => {
    const broken: DecisionCache = {
      tier: 'l2',
      get: async () => {
        throw new Error('redis gone');
      },
      set: async () => {
        throw new Error('redis gone');
      },
    };
    const svc = new DecisionService({
      l1,
      l2: broken,
      generation: generationAt(1),
      store: stubStore('relational', { allowed: true }),
    });

    // Redis being down is a latency problem, never a correctness one.
    expect((await svc.check(query)).allowed).toBe(true);
  });
});
