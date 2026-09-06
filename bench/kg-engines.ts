import type { Pool } from 'pg';
import {
  Neo4jProjector,
  Neo4jQueries,
  PgKgProjector,
  PgKgQueries,
  PostgresReachability,
  type GrantRef,
  type GraphQueries,
} from '@permguard/authorization';
import { neo4jDriver, pgPool } from '@permguard/platform';

/**
 * Two knowledge graphs, four questions.
 *
 * The first version of this repository benchmarked one question — the boolean
 * check — found the relational schema faster, and deleted Neo4j on that result.
 * That was measuring the cheapest question and deciding on it. `check` stops at
 * the first path it finds, which is the shape an index scan is best at and the
 * shape that wastes a traversal.
 *
 * This measures all four, against two stores holding the *same graph in the
 * same shape*: a generic property graph in Postgres (`kg_nodes` / `kg_edges`,
 * indexed in both directions) and the same nodes and edges in Neo4j. The
 * normalized relational schema is kept as a third contender on Q1 only, because
 * it is what actually serves traffic.
 *
 * Q1 check   can this user do this here            forward, stops early
 * Q2 why     every path that grants it             forward, no early exit
 * Q3 who     everyone who can reach this resource  BACKWARD
 * Q4 blast   who loses access if this grant goes   backward, plus a subtraction
 *
 * Both engines are asked identical questions through the same interface, and
 * the benchmark asserts they agree before it times anything. A faster wrong
 * answer is not a result.
 *
 * DESTRUCTIVE. It replaces the contents of both stores and restores the demo
 * data on a clean exit.
 */
export interface Shape {
  readonly name: string;
  readonly teamDepth: number;
  readonly resourceDepth: number;
  readonly siblings: number;
  readonly usersPerTeam: number;
  readonly noiseGrants: number;
}

export const SHAPES: readonly Shape[] = [
  { name: 'small', teamDepth: 3, resourceDepth: 3, siblings: 3, usersPerTeam: 3, noiseGrants: 500 },
  { name: 'medium', teamDepth: 5, resourceDepth: 6, siblings: 4, usersPerTeam: 4, noiseGrants: 5_000 },
  { name: 'large', teamDepth: 8, resourceDepth: 10, siblings: 5, usersPerTeam: 5, noiseGrants: 25_000 },
];

/** Q3 and Q4 do orders of magnitude more work, so they get fewer samples. */
const ITER = { check: 200, why: 200, who: 50, blast: 15 } as const;

interface Timing {
  readonly p50: number;
  readonly p95: number;
}

async function main(): Promise<void> {
  const pool = pgPool();
  const driver = neo4jDriver();
  const kgProjector = new PgKgProjector(pool);
  const neoProjector = new Neo4jProjector(driver);

  const rows: string[] = [];

  try {
    for (const shape of SHAPES) {
      await generate(pool, shape);
      await kgProjector.rebuild();
      await neoProjector.ensureConstraints();
      await neoProjector.syncTopology(pool);
      await neoProjector.syncGrants(pool);

      const kg: GraphQueries = new PgKgQueries(pool);
      const neo: GraphQueries = new Neo4jQueries(driver);
      const relational = new PostgresReachability(pool);

      const deepUser = `bench-user-${shape.teamDepth - 1}-0`;
      const leaf = `bench-res-${shape.resourceDepth - 1}-0`;
      const rootGrant: GrantRef = {
        subjectId: 'bench-team-0-0',
        role: 'viewer',
        resourceId: 'bench-res-0-0',
      };

      process.stdout.write(`\n[${shape.name}] projecting done, checking agreement ... `);
      await assertAgreement(kg, neo, deepUser, leaf, rootGrant);
      process.stdout.write('agree\n');

      const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        process.stdout.write(`  ${shape.name}/${label} ... `);
        const r = await fn();
        process.stdout.write('done\n');
        return r;
      };

      const t = {
        checkKg: await step('Q1 pg-kg', () => time(ITER.check, () => kg.check(deepUser, 'read', leaf))),
        checkNeo: await step('Q1 neo4j', () => time(ITER.check, () => neo.check(deepUser, 'read', leaf))),
        checkRel: await step('Q1 relational', () =>
          time(ITER.check, () =>
            relational.check({ userId: deepUser, permission: 'read', resourceId: leaf }),
          ),
        ),
        whyKg: await step('Q2 pg-kg', () => time(ITER.why, () => kg.why(deepUser, 'read', leaf))),
        whyNeo: await step('Q2 neo4j', () => time(ITER.why, () => neo.why(deepUser, 'read', leaf))),
        whoKg: await step('Q3 pg-kg', () => time(ITER.who, () => kg.who('read', leaf))),
        whoNeo: await step('Q3 neo4j', () => time(ITER.who, () => neo.who('read', leaf))),
        blastKg: await step('Q4 pg-kg', () => time(ITER.blast, () => kg.blastRadius(rootGrant, 'read'))),
        blastNeo: await step('Q4 neo4j', () => time(ITER.blast, () => neo.blastRadius(rootGrant, 'read'))),
      };

      const users = await count(pool, 'users');
      const grants = await count(pool, 'grants');
      const header =
        `${shape.name.padEnd(7)} depth ${shape.teamDepth}/${shape.resourceDepth}  ` +
        `${users} users  ${grants} grants`;
      rows.push(
        [
          header,
          `  Q1 check   pg-kg ${fmt(t.checkKg)}   neo4j ${fmt(t.checkNeo)}   (relational ${fmt(t.checkRel)})`,
          `  Q2 why     pg-kg ${fmt(t.whyKg)}   neo4j ${fmt(t.whyNeo)}`,
          `  Q3 who     pg-kg ${fmt(t.whoKg)}   neo4j ${fmt(t.whoNeo)}`,
          `  Q4 blast   pg-kg ${fmt(t.blastKg)}   neo4j ${fmt(t.blastNeo)}`,
        ].join('\n'),
      );
      console.log(rows[rows.length - 1] + '\n');
    }

    console.log('\n=== two knowledge graphs, four questions (p50/p95 ms) ===\n');
    for (const r of rows) console.log(r + '\n');
  } finally {
    await restore(pool, kgProjector, neoProjector, driver);
    await pool.end();
    await driver.close();
  }
}

/**
 * Nothing is timed until the two stores have been shown to answer identically.
 * Q3 and Q4 return sets, so they are compared as sorted sets rather than by
 * length — two engines can easily return the same number of wrong rows.
 */
async function assertAgreement(
  kg: GraphQueries,
  neo: GraphQueries,
  user: string,
  resource: string,
  grant: GrantRef,
): Promise<void> {
  const checks: Array<[string, unknown, unknown]> = [
    ['check', await kg.check(user, 'read', resource), await neo.check(user, 'read', resource)],
    ['why', (await kg.why(user, 'read', resource)).length, (await neo.why(user, 'read', resource)).length],
    [
      'who',
      (await kg.who('read', resource)).map((r) => r.userId).sort().join(','),
      (await neo.who('read', resource)).map((r) => r.userId).sort().join(','),
    ],
    [
      'blast',
      (await kg.blastRadius(grant, 'read')).map((r) => `${r.userId}:${r.resourceId}`).sort().join(','),
      (await neo.blastRadius(grant, 'read')).map((r) => `${r.userId}:${r.resourceId}`).sort().join(','),
    ],
  ];
  for (const [name, a, b] of checks) {
    if (String(a) !== String(b)) {
      throw new Error(`engines disagree on ${name}:\n  pg-kg = ${String(a)}\n  neo4j = ${String(b)}`);
    }
  }
}

async function time(iterations: number, fn: () => Promise<unknown>): Promise<Timing> {
  const warm = Math.min(20, iterations);
  for (let i = 0; i < warm; i += 1) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: samples[Math.floor(samples.length * 0.5)]!,
    p95: samples[Math.floor(samples.length * 0.95)]!,
  };
}

const fmt = (t: Timing): string =>
  `${t.p50.toFixed(2).padStart(8)}/${t.p95.toFixed(2).padStart(8)}`;

async function count(pool: Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

/**
 * A nested org with people in it.
 *
 * The earlier generator created two users, which made Q3 and Q4 trivial — "who
 * can reach this" is not a question when the answer is always the same two
 * names. Users are spread across every team here so the backward traversal has
 * a real fan-out to walk, and the one relevant grant sits at the top of both
 * chains so nothing is answerable by a lucky first hit.
 */
export async function generate(pool: Pool, shape: Shape): Promise<void> {
  await wipe(pool);

  const teams: Array<[string, string | null]> = [];
  for (let d = 0; d < shape.teamDepth; d += 1) {
    for (let s = 0; s < (d === 0 ? 1 : shape.siblings); s += 1) {
      teams.push([`bench-team-${d}-${s}`, d === 0 ? null : `bench-team-${d - 1}-0`]);
    }
  }
  const resources: Array<[string, string | null]> = [];
  for (let d = 0; d < shape.resourceDepth; d += 1) {
    for (let s = 0; s < (d === 0 ? 1 : shape.siblings); s += 1) {
      resources.push([`bench-res-${d}-${s}`, d === 0 ? null : `bench-res-${d - 1}-0`]);
    }
  }

  for (const [id, parent] of teams) {
    await pool.query('INSERT INTO teams (id, display_name, parent_id) VALUES ($1,$1,$2)', [id, parent]);
  }
  for (const [id, parent] of resources) {
    await pool.query('INSERT INTO resources (id, kind, parent_id) VALUES ($1,$$bench$$,$2)', [id, parent]);
  }

  const users: Array<[string, string]> = [];
  for (const [teamId] of teams) {
    const d = teamId.split('-')[2]!;
    const s = teamId.split('-')[3]!;
    for (let i = 0; i < shape.usersPerTeam; i += 1) {
      // The user the benchmark asks about is `bench-user-<deepest>-0`, i.e. the
      // first member of the deepest team, furthest from the grant.
      users.push([`bench-user-${d}-${s}${i === 0 ? '' : `-${i}`}`, teamId]);
    }
  }
  for (const [id] of users) {
    await pool.query('INSERT INTO users (id, display_name) VALUES ($1,$1)', [id]);
  }
  for (const [id, teamId] of users) {
    await pool.query('INSERT INTO memberships (user_id, team_id) VALUES ($1,$2)', [id, teamId]);
  }

  await pool.query(
    `INSERT INTO grants (id, subject_kind, subject_id, role, resource_id)
     VALUES ('bench-grant','team','bench-team-0-0','viewer','bench-res-0-0')`,
  );

  const teamIds = teams.map(([id]) => id);
  const resourceIds = resources.map(([id]) => id);
  // Noise has to be *distinct* noise. The first version walked two indices with
  // fixed strides, so the (team, role, resource) triples cycled with a short
  // period and `ON CONFLICT DO NOTHING` silently discarded nearly all of them —
  // a run configured for 25,000 grants inserted 277, and the benchmark reported
  // times for a table that was never populated. Extra subject nodes give the
  // combination space room to actually hold the requested volume.
  const values: string[] = [];
  const noiseTeams: string[] = [];
  for (let i = 0; i < Math.ceil(shape.noiseGrants / Math.max(1, resourceIds.length)) + 1; i += 1) {
    noiseTeams.push(`bench-noise-team-${i}`);
  }
  for (const id of noiseTeams) {
    await pool.query('INSERT INTO teams (id, display_name, parent_id) VALUES ($1,$1,NULL)', [id]);
  }
  for (let i = 0; i < shape.noiseGrants; i += 1) {
    const t = noiseTeams[Math.floor(i / resourceIds.length) % noiseTeams.length]!;
    const r = resourceIds[i % resourceIds.length]!;
    // `editor` does confer `read`, so these are deliberately attached to teams
    // nobody is a member of: they enlarge the tables the queries scan without
    // changing any answer.
    values.push(`('noise-${i}','team','${t}','editor','${r}')`);
  }
  for (let i = 0; i < values.length; i += 2000) {
    await pool.query(
      `INSERT INTO grants (id, subject_kind, subject_id, role, resource_id)
       VALUES ${values.slice(i, i + 2000).join(',')} ON CONFLICT DO NOTHING`,
    );
  }
  await pool.query('ANALYZE grants; ANALYZE memberships; ANALYZE teams; ANALYZE resources; ANALYZE users');
}

export async function wipe(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE grants, memberships, resources, teams, users, audit_log, outbox, kg_edges, kg_nodes CASCADE',
  );
}

async function restore(
  pool: Pool,
  kg: PgKgProjector,
  neo: Neo4jProjector,
  driver: import('neo4j-driver').Driver,
): Promise<void> {
  await wipe(pool);
  const session = driver.session();
  try {
    await session.run('MATCH (n) DETACH DELETE n');
  } finally {
    await session.close();
  }
  const { seed } = await import('../apps/worker/src/seed');
  await seed(pool);
  await kg.rebuild();
  await neo.ensureConstraints();
  await neo.syncTopology(pool);
  await neo.syncGrants(pool);
  console.log('(demo data restored)');
}

// Only run when invoked directly, so the generator can be imported by probes
// without kicking off a twenty-minute benchmark as a side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
