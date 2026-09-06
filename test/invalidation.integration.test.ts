import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { OutboxGeneration } from '@permguard/authorization';
import { pgPool } from '@permguard/platform';
import { DEMO_REVOKE } from '../apps/worker/src/seed';
import { settle, sleep, startApiNodes, startWorker, stopAll, type Node } from '../ops/harness';

/**
 * The claim on the front page, tested.
 *
 * `bench/invalidation-window.ts` produces the number; this asserts the
 * property, which is the part that must not regress silently. A benchmark that
 * gets slower is a discussion. A revoke that never lands on one of three nodes
 * is an incident, and it is the kind that a single-process test cannot see.
 */
describe('a revoke reaches every node', () => {
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let nodes: Node[];
  let pool: Pool;

  beforeAll(async () => {
    pool = pgPool();
    worker = await startWorker();
    nodes = await startApiNodes(3, 3921);
  }, 180_000);

  afterAll(async () => {
    stopAll([worker, ...(nodes ?? []).map((n) => n.proc)]);
    await pool.end();
  });

  it('every node denies within one second of the revoke committing', async () => {
    await ensureGranted(nodes[0]!);
    await settle(nodes);
    await waitForAll(nodes, true);

    const target = await findDemoGrant(nodes[0]!);
    const res = await fetch(`${nodes[0]!.url}/admin/grants/${target.id}`, { method: 'DELETE' });
    const { committedAt } = (await res.json()) as { committedAt: number };

    await waitForAll(nodes, false, 1_000);
    const elapsed = Date.now() - committedAt;

    // Generous on purpose. The measured p95 is an order of magnitude under
    // this; the assertion is that propagation happens at all, on every node,
    // not a restatement of the benchmark.
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);

  it('no node is still serving an allow from cache afterwards', async () => {
    const answers = await Promise.all(nodes.map((n) => check(n)));
    for (const a of answers) {
      expect(a.allowed).toBe(false);
      // A cached deny is fine; a cached *allow* would mean the generation moved
      // without the cache following it.
      expect(a.reason).toBe('no-path');
    }
  });

  it('the audit entry outlives the grant row it describes', async () => {
    // The grant row is gone. This is the question audit exists to answer, and
    // it is unanswerable from current state.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE resource_id = $1 AND event_type = 'GrantRevoked'`,
      [DEMO_REVOKE.resourceId],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('the backstop advances a node that never sees the event', async () => {
    // Nothing calls `observe()` here — this is the path that runs when the
    // broker drops a message, and the only thing standing between a lost
    // message and a permanently stale node.
    const generation = new OutboxGeneration({ pool, backstopMs: 200 });
    await generation.refresh();
    const before = generation.current();
    generation.start();

    try {
      await ensureGranted(nodes[0]!);
      const deadline = Date.now() + 5_000;
      while (generation.current() === before && Date.now() < deadline) await sleep(50);
      expect(generation.current()).toBeGreaterThan(before);
    } finally {
      generation.stop();
    }
  }, 30_000);
});

async function check(node: Node): Promise<{ allowed: boolean; reason: string; source: string }> {
  const res = await fetch(
    `${node.url}/check?permission=${DEMO_REVOKE.permission}&resource=${DEMO_REVOKE.resourceId}`,
    { headers: { 'x-user-id': DEMO_REVOKE.userId } },
  );
  return (await res.json()) as { allowed: boolean; reason: string; source: string };
}

async function waitForAll(nodes: readonly Node[], allowed: boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await Promise.all(nodes.map((n) => check(n)));
    if (seen.every((d) => d.allowed === allowed)) return;
    await sleep(10);
  }
  throw new Error(`nodes did not all reach allowed=${allowed} within ${timeoutMs}ms`);
}

async function ensureGranted(node: Node): Promise<void> {
  await fetch(`${node.url}/admin/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(DEMO_REVOKE.grant),
  });
}

async function findDemoGrant(node: Node): Promise<{ id: string }> {
  const { grants } = (await (await fetch(`${node.url}/admin/grants`)).json()) as {
    grants: Array<{ id: string; subjectId: string; resourceId: string }>;
  };
  const target = grants.find(
    (g) => g.subjectId === DEMO_REVOKE.grant.subjectId && g.resourceId === DEMO_REVOKE.grant.resourceId,
  );
  if (!target) throw new Error('demo grant missing');
  return target;
}
