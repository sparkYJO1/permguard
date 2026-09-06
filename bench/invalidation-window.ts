import { startApiNodes, startWorker, stopAll, settle, sleep, type Node } from '../ops/harness';
import { DEMO_REVOKE } from '../apps/worker/src/seed';

/**
 * The number this repository exists to produce.
 *
 * A permission is revoked at t0. Every node in the cluster is being asked the
 * same question continuously. The window is the distance from the revoke
 * committing to the *last* node returning a deny — not the first, and not the
 * average, because a fired employee only needs one node that still says yes.
 *
 * Measurement notes, so the number can be argued with:
 *
 *  - t0 is taken inside the API process immediately after the transaction
 *    commits, and is reported on the revoke response. The clock is the same
 *    host for every process here, so no clock skew is being hidden.
 *  - Each node is polled by a loop that issues the next request as soon as the
 *    previous one returns. The resolution of the result is therefore the poll
 *    latency, which is printed alongside it. A window smaller than the
 *    resolution would not be believable and is not claimed.
 *  - Caches are warmed before each round. Measuring against a cold cache would
 *    flatter the result enormously, because the stale answer being raced is one
 *    that has to exist first.
 */
// 40, not 10. At twenty rounds p95 is the second-slowest sample and one
// scheduling hiccup moves it by 70ms; at forty it repeats to within a
// millisecond across runs. A published percentile that does not survive being
// re-run is not a measurement.
const ROUNDS = Number(process.env.ROUNDS ?? 40);
const NODE_COUNT = 3;
/** Must match what the worker uses, or the phase sampling below is wrong. */
const RELAY_INTERVAL_MS = Number(process.env.OUTBOX_POLL_MS ?? 50);

interface RoundResult {
  readonly windowMs: number;
  readonly perNode: Record<string, number>;
  readonly resolutionMs: number;
}

async function main(): Promise<void> {
  const worker = await startWorker();
  const nodes = await startApiNodes(NODE_COUNT);
  const results: RoundResult[] = [];

  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      await ensureGranted(nodes[0]!);
      await settle(nodes);
      await warm(nodes);

      const result = await measureOnce(nodes);
      results.push(result);
      process.stdout.write(
        `round ${String(round + 1).padStart(2)}  window ${result.windowMs.toString().padStart(4)}ms  ` +
          `(${Object.entries(result.perNode).map(([n, ms]) => `${n}:${ms}ms`).join(' ')})  ` +
          `resolution ${result.resolutionMs.toFixed(1)}ms\n`,
      );
    }
    report(results);
  } finally {
    stopAll([worker, ...nodes.map((n) => n.proc)]);
  }
}

/** Puts the grant back so the next round has something to take away. */
async function ensureGranted(node: Node): Promise<void> {
  const g = DEMO_REVOKE.grant;
  await fetch(`${node.url}/admin/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(g),
  });
}

/**
 * Every node must hold a *cached* allow before the revoke, or there is nothing
 * stale to race and the measurement is meaningless.
 *
 * This is stricter than it looks. The previous round's deny is still cached
 * under whatever generation the node currently holds, so re-granting is not
 * enough — the node has to have learned the re-grant's generation too. Waiting
 * for an observable allow is the precondition; giving up quietly here is what
 * produced negative windows the first time this was run.
 */
async function warm(nodes: readonly Node[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await Promise.all(nodes.map((n) => check(n)));
    if (seen.every((d) => d.allowed)) break;
    await sleep(25);
  }

  const stillDenying = (await Promise.all(nodes.map(async (n) => [n, await check(n)] as const)))
    .filter(([, d]) => !d.allowed)
    .map(([n]) => n.id);
  if (stillDenying.length > 0) {
    throw new Error(`nodes still denying before the revoke: ${stillDenying.join(', ')}`);
  }

  // Now make sure the allow is actually served from cache on every node.
  for (const node of nodes) {
    for (let i = 0; i < 10; i += 1) {
      const d = await check(node);
      if (d.source === 'l1' || d.source === 'l2') break;
      if (i === 9) throw new Error(`${node.id} never served the allow from cache`);
    }
  }
}

async function measureOnce(nodes: readonly Node[]): Promise<RoundResult> {
  const grants = (await (await fetch(`${nodes[0]!.url}/admin/grants`)).json()) as {
    grants: Array<{ id: string; subjectId: string; resourceId: string; role: string }>;
  };
  const target = grants.grants.find(
    (g) => g.subjectId === DEMO_REVOKE.grant.subjectId && g.resourceId === DEMO_REVOKE.grant.resourceId,
  );
  if (!target) throw new Error('demo grant is missing; cannot measure a revoke');

  const stop = { now: false };
  const firstDeny: Record<string, number> = {};
  const gaps: number[] = [];
  // Set the instant the revoke request is dispatched. A deny observed before
  // this cannot have been caused by the revoke, and counting one would produce
  // a window that precedes its own cause.
  const revoke = { dispatchedAt: Number.POSITIVE_INFINITY };

  const pollers = nodes.map(async (node) => {
    let previous = Date.now();
    while (!stop.now) {
      const d = await check(node);
      const at = Date.now();
      gaps.push(at - previous);
      previous = at;
      if (!d.allowed && at >= revoke.dispatchedAt && firstDeny[node.id] === undefined) {
        firstDeny[node.id] = at;
        return;
      }
    }
  });

  // Give the pollers a moment to be in flight, then wait a random extra slice
  // of one relay cycle before revoking.
  //
  // The randomness is not decoration. The relay polls on a fixed interval, so
  // the window depends on where in that cycle the commit lands. A fixed delay
  // here phase-locks every round to the same point in the cycle and reports one
  // arbitrary sample as if it were the distribution — which is how a 200ms poll
  // first measured *faster* than a 50ms one, and how the whole number nearly
  // went into the README wrong.
  await sleep(150 + Math.random() * RELAY_INTERVAL_MS);

  revoke.dispatchedAt = Date.now();
  const res = await fetch(`${nodes[0]!.url}/admin/grants/${target.id}`, { method: 'DELETE' });
  const { committedAt } = (await res.json()) as { committedAt: number };

  const deadline = Date.now() + 30_000;
  while (Object.keys(firstDeny).length < nodes.length && Date.now() < deadline) await sleep(5);
  stop.now = true;
  await Promise.all(pollers);

  if (Object.keys(firstDeny).length < nodes.length) {
    throw new Error(`only ${Object.keys(firstDeny).length}/${nodes.length} nodes denied within 30s`);
  }

  const perNode = Object.fromEntries(
    Object.entries(firstDeny).map(([id, at]) => [id, at - committedAt]),
  );
  return {
    windowMs: Math.max(...Object.values(perNode)),
    perNode,
    resolutionMs: median(gaps),
  };
}

async function check(node: Node): Promise<{ allowed: boolean; source: string }> {
  const res = await fetch(
    `${node.url}/check?permission=${DEMO_REVOKE.permission}&resource=${DEMO_REVOKE.resourceId}`,
    { headers: { 'x-user-id': DEMO_REVOKE.userId } },
  );
  return (await res.json()) as { allowed: boolean; source: string };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

function report(results: readonly RoundResult[]): void {
  const windows = results.map((r) => r.windowMs);
  console.log('\n--- invalidation window: revoke committed -> every node denies ---');
  console.log(`rounds      ${results.length}`);
  console.log(`nodes       ${NODE_COUNT}`);
  console.log(`p50         ${percentile(windows, 50)} ms`);
  console.log(`p95         ${percentile(windows, 95)} ms`);
  console.log(`max         ${Math.max(...windows)} ms`);
  console.log(`min         ${Math.min(...windows)} ms`);
  console.log(`resolution  ~1 ms (median gap between successive checks on a node)`);
  console.log(`relay poll  ${RELAY_INTERVAL_MS} ms (OUTBOX_POLL_MS; the largest term below)`);
  console.log(
    '\nBackstop, if the event is lost entirely: GENERATION_BACKSTOP_MS ' +
      `(${process.env.GENERATION_BACKSTOP_MS ?? 5000}ms). That is the honest worst case, ` +
      'and it is the reason the poll exists.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
