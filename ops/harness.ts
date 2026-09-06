import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

export interface Node {
  readonly id: string;
  readonly port: number;
  readonly url: string;
  readonly proc: ChildProcess;
}

/**
 * Starts the real compiled binaries as separate processes.
 *
 * The measurement is only worth reading if the thing measured is the thing
 * shipped. Importing the worker's pipeline into the test process would share a
 * Redis client, a Kafka connection and an event loop with the code under test,
 * and would quietly measure something faster than production.
 */
export async function startWorker(env: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const proc = spawn('node', [join(ROOT, 'apps/worker/dist/main.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeLogs('worker', proc);
  await waitForHttp('http://localhost:3910/health');
  return proc;
}

export async function startApiNodes(count: number, basePort = 3901): Promise<Node[]> {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `api${i + 1}`;
    const port = basePort + i;
    const proc = spawn('node', [join(ROOT, 'apps/api/dist/main.js')], {
      env: { ...process.env, NODE_ID: id, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeLogs(id, proc);
    nodes.push({ id, port, url: `http://localhost:${port}`, proc });
  }
  await Promise.all(nodes.map((n) => waitForHttp(`${n.url}/health`)));
  // Each node joins its own consumer group; a group that has not finished
  // joining drops the message it was started to receive. Waiting for the first
  // successful poll here is the difference between measuring invalidation and
  // measuring consumer-group rebalance.
  await settle(nodes);
  return nodes;
}

export function stopAll(procs: Array<ChildProcess | undefined>): void {
  for (const p of procs) p?.kill('SIGTERM');
}

export async function waitForHttp(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`${url} never became ready: ${String(last)}`);
}

/**
 * Waits until every node reports the same generation, so a measurement starts
 * from a converged cluster rather than from one still catching up.
 */
export async function settle(nodes: readonly Node[], timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gens = await Promise.all(
      nodes.map((n) => fetch(`${n.url}/generation`).then((r) => r.json() as Promise<{ generation: number }>)),
    );
    const first = gens[0]!.generation;
    if (first > 0 && gens.every((g) => g.generation === first)) return first;
    await sleep(100);
  }
  throw new Error('nodes did not converge on a generation');
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pipeLogs(label: string, proc: ChildProcess): void {
  if (!process.env.HARNESS_VERBOSE) return;
  proc.stdout?.on('data', (b: Buffer) => process.stdout.write(`[${label}] ${b}`));
  proc.stderr?.on('data', (b: Buffer) => process.stderr.write(`[${label}!] ${b}`));
}
