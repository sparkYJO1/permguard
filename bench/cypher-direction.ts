import { Neo4jProjector, PgKgProjector } from '@permguard/authorization';
import { neo4jDriver, pgPool } from '@permguard/platform';
import { SHAPES, generate } from './kg-engines';

/**
 * Which way should the Cypher walk?
 *
 * On the largest shape the resource end of the graph has hundreds of incoming
 * GRANTED edges per node and the user end has a handful of outgoing ones. Neo4j
 * walks whatever you start it from, so the starting point is not a detail — it
 * is most of the runtime. Postgres never had to choose: the SQL builds both
 * closures and lets the planner decide which to drive from.
 *
 * This exists because the first benchmark had Neo4j 60x slower on a boolean
 * check, which is not a believable engine difference and turned out not to be
 * one.
 */
const d = 20;

const RESOURCE_FIRST = `
MATCH (u:User {id: $userId}), (r:Resource {id: $resourceId})
MATCH (r)-[:CHILD_OF*0..${d}]->(anc:Resource)<-[g:GRANTED]-(s)
WHERE g.role IN $roles
  AND (s.id = u.id OR (s:Team AND EXISTS {
        MATCH (u)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(s) }))
RETURN s.id LIMIT 1`;

const SUBJECT_FIRST = `
MATCH (u:User {id: $userId})
OPTIONAL MATCH (u)-[:MEMBER_OF]->(:Team)-[:CHILD_OF*0..${d}]->(t:Team)
WITH u, collect(DISTINCT t) AS teams
UNWIND (teams + [u]) AS s
MATCH (s)-[g:GRANTED]->(anc:Resource)
WHERE g.role IN $roles
MATCH (r:Resource {id: $resourceId})-[:CHILD_OF*0..${d}]->(anc)
RETURN s.id LIMIT 1`;

async function main(): Promise<void> {
  const pool = pgPool();
  const driver = neo4jDriver();
  const shape = SHAPES[SHAPES.length - 1]!;

  console.log(`generating '${shape.name}' ...`);
  await generate(pool, shape);
  await new PgKgProjector(pool).rebuild();
  const np = new Neo4jProjector(driver);
  await np.ensureConstraints();
  await np.syncTopology(pool);
  await np.syncGrants(pool);

  const params = {
    userId: `bench-user-${shape.teamDepth - 1}-0`,
    resourceId: `bench-res-${shape.resourceDepth - 1}-0`,
    roles: ['viewer', 'editor', 'owner'],
  };

  console.log(`\nshape ${shape.name}, ${shape.noiseGrants} noise grants\n`);
  for (const [name, q] of [
    ['resource-first', RESOURCE_FIRST],
    ['subject-first', SUBJECT_FIRST],
  ] as const) {
    const session = driver.session({ defaultAccessMode: 'READ' });
    let hits = 0;
    for (let i = 0; i < 10; i += 1) hits += (await session.run(q, params)).records.length;
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t = process.hrtime.bigint();
      await session.run(q, params);
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    samples.sort((a, b) => a - b);
    // Both must return the same verdict, or this is comparing two questions.
    console.log(
      `${name.padEnd(15)} p50 ${samples[50]!.toFixed(2).padStart(8)}  ` +
        `p95 ${samples[95]!.toFixed(2).padStart(8)}   (found a path in ${hits}/10 warmups)`,
    );
    await session.close();
  }

  await pool.end();
  await driver.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
