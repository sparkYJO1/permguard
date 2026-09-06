import type { Pool } from 'pg';
import { Neo4jProjector, Neo4jReachability, PostgresReachability } from '@permguard/authorization';
import type { CheckQuery, ReachabilityStore } from '@permguard/authorization';
import { neo4jDriver, pgPool } from '@permguard/platform';

/**
 * Does Neo4j earn its place?
 *
 * The brief this repository was built from says the graph store has to be
 * measured against a recursive CTE rather than asserted to beat it, and that if
 * it cannot be defended it should be deleted. This is that measurement.
 *
 * It is deliberately unkind to the graph in the ways that matter:
 *
 *  - Both stores run the exact code the API runs. No special-cased query, no
 *    warm session pool for one and cold for the other.
 *  - The relational side is fully indexed. Beating an unindexed table would
 *    prove nothing.
 *  - The hard case is a *deny*. An allow can stop at the first grant it finds;
 *    a deny has to exhaust the search space, and that is where an inheritance
 *    model either holds up or falls over.
 *  - Depth and breadth both grow, because a graph database that only wins on a
 *    two-hop question is a graph database you do not need.
 *
 * DESTRUCTIVE. It replaces the contents of both stores. Re-run
 * `node apps/worker/dist/bootstrap.js` afterwards to get the demo data back;
 * this script does it for you on a clean exit.
 */
interface Shape {
  readonly name: string;
  readonly teamDepth: number;
  readonly resourceDepth: number;
  readonly siblings: number;
  readonly noiseGrants: number;
}

const SHAPES: readonly Shape[] = [
  { name: 'shallow', teamDepth: 2, resourceDepth: 2, siblings: 4, noiseGrants: 1_000 },
  { name: 'medium', teamDepth: 5, resourceDepth: 6, siblings: 6, noiseGrants: 10_000 },
  { name: 'deep', teamDepth: 10, resourceDepth: 12, siblings: 8, noiseGrants: 40_000 },
  // Past anything an organisation produces. Included because it is where the
  // curves cross, and leaving it out would have made the conclusion look
  // stronger than the evidence supports.
  { name: 'unreal', teamDepth: 20, resourceDepth: 25, siblings: 8, noiseGrants: 200_000 },
];

const ITERATIONS = Number(process.env.ITERATIONS ?? 300);

async function main(): Promise<void> {
  const pool = pgPool();
  const driver = neo4jDriver();
  const projector = new Neo4jProjector(driver);
  const graph = new Neo4jReachability(driver);
  const relational = new PostgresReachability(pool);

  const rows: string[] = [];

  try {
    for (const shape of SHAPES) {
      await generate(pool, shape);
      await projector.ensureConstraints();
      await projector.syncTopology(pool);
      await projector.syncGrants(pool);

      const allow: CheckQuery = { userId: 'bench-user', permission: 'read', resourceId: leafResource(shape) };
      const deny: CheckQuery = { userId: 'bench-outsider', permission: 'delete', resourceId: leafResource(shape) };

      // Confirm the two agree before timing them. A faster wrong answer is not
      // a result, and this is the only thing standing between the table below
      // and a benchmark of two different questions.
      for (const q of [allow, deny]) {
        const a = await relational.check(q);
        const b = await graph.check(q);
        if (a.allowed !== b.allowed) {
          throw new Error(`stores disagree on ${JSON.stringify(q)}: cte=${a.allowed} graph=${b.allowed}`);
        }
      }

      const measured = {
        cteAllow: await time(relational, allow),
        graphAllow: await time(graph, allow),
        cteDeny: await time(relational, deny),
        graphDeny: await time(graph, deny),
      };

      rows.push(
        `${shape.name.padEnd(8)} ` +
          `depth ${String(shape.teamDepth).padStart(2)}/${String(shape.resourceDepth).padStart(2)}  ` +
          `grants ${String(shape.noiseGrants).padStart(6)}  ` +
          `| allow  cte ${fmt(measured.cteAllow)}  graph ${fmt(measured.graphAllow)}  ` +
          `| deny   cte ${fmt(measured.cteDeny)}  graph ${fmt(measured.graphDeny)}`,
      );
      console.log(rows[rows.length - 1]);
    }

    console.log('\n--- reachability: recursive CTE vs Cypher ---');
    console.log(`iterations per cell: ${ITERATIONS}   (p50/p95 in ms)\n`);
    for (const r of rows) console.log(r);
  } finally {
    await restore(pool, projector);
    await pool.end();
    await driver.close();
  }
}

interface Timing {
  readonly p50: number;
  readonly p95: number;
}

async function time(store: ReachabilityStore, q: CheckQuery): Promise<Timing> {
  for (let i = 0; i < 30; i += 1) await store.check(q); // warm connections and page cache
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const t = process.hrtime.bigint();
    await store.check(q);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: samples[Math.floor(samples.length * 0.5)]!,
    p95: samples[Math.floor(samples.length * 0.95)]!,
  };
}

const fmt = (t: Timing): string => `${t.p50.toFixed(2).padStart(6)}/${t.p95.toFixed(2).padStart(6)}`;

const leafResource = (s: Shape): string => `bench-res-${s.resourceDepth - 1}-0`;

/**
 * Builds a chain of nested teams and a chain of nested resources, with siblings
 * at every level so the traversal has somewhere wrong to go, and a pile of
 * unrelated grants so neither store is answering out of a table small enough to
 * live in one page.
 *
 * The single relevant grant sits at the *top* of both chains, so the allow case
 * is the full walk rather than a lucky first hit.
 */
async function generate(pool: Pool, shape: Shape): Promise<void> {
  await wipe(pool);

  const teams: Array<[string, string | null]> = [];
  for (let d = 0; d < shape.teamDepth; d += 1) {
    for (let s = 0; s < (d === shape.teamDepth - 1 ? 1 : shape.siblings); s += 1) {
      teams.push([`bench-team-${d}-${s}`, d === 0 ? null : `bench-team-${d - 1}-0`]);
    }
  }
  const resources: Array<[string, string | null]> = [];
  for (let d = 0; d < shape.resourceDepth; d += 1) {
    for (let s = 0; s < (d === shape.resourceDepth - 1 ? 1 : shape.siblings); s += 1) {
      resources.push([`bench-res-${d}-${s}`, d === 0 ? null : `bench-res-${d - 1}-0`]);
    }
  }

  await pool.query(
    `INSERT INTO users (id, display_name) VALUES ('bench-user','bench'),('bench-outsider','bench')`,
  );
  // Parents first: the chain is built top-down so the foreign key never dangles.
  for (const [id, parent] of teams) {
    await pool.query('INSERT INTO teams (id, display_name, parent_id) VALUES ($1,$1,$2)', [id, parent]);
  }
  for (const [id, parent] of resources) {
    await pool.query('INSERT INTO resources (id, kind, parent_id) VALUES ($1,$$bench$$,$2)', [id, parent]);
  }

  // The user sits at the deepest team; the grant sits at the shallowest.
  await pool.query('INSERT INTO memberships (user_id, team_id) VALUES ($1,$2)', [
    'bench-user',
    `bench-team-${shape.teamDepth - 1}-0`,
  ]);
  await pool.query(
    `INSERT INTO grants (id, subject_kind, subject_id, role, resource_id)
     VALUES ('bench-grant','team','bench-team-0-0','viewer','bench-res-0-0')`,
  );

  const noiseTeams = teams.map(([id]) => id);
  const noiseResources = resources.map(([id]) => id);
  const values: string[] = [];
  for (let i = 0; i < shape.noiseGrants; i += 1) {
    const t = noiseTeams[i % noiseTeams.length]!;
    const r = noiseResources[(i * 7 + 3) % noiseResources.length]!;
    // `editor` never grants `delete`, so this noise cannot accidentally satisfy
    // the deny case — it only has to be scanned past.
    values.push(`('noise-${i}','team','${t}','editor','${r}')`);
  }
  for (let i = 0; i < values.length; i += 2000) {
    await pool.query(
      `INSERT INTO grants (id, subject_kind, subject_id, role, resource_id)
       VALUES ${values.slice(i, i + 2000).join(',')}
       ON CONFLICT DO NOTHING`,
    );
  }
  await pool.query('ANALYZE grants; ANALYZE memberships; ANALYZE teams; ANALYZE resources');
}

async function wipe(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE grants, memberships, resources, teams, users, audit_log, outbox CASCADE');
}

async function restore(pool: Pool, projector: Neo4jProjector): Promise<void> {
  await wipe(pool);
  const session = (projector as unknown as { driver: { session: () => any } }).driver.session();
  try {
    await session.run('MATCH (n) DETACH DELETE n');
  } finally {
    await session.close();
  }
  const { seed } = await import('../apps/worker/src/seed');
  await seed(pool);
  await projector.ensureConstraints();
  await projector.syncTopology(pool);
  await projector.syncGrants(pool);
  console.log('\n(demo data restored)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
