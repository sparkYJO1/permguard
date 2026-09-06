# ADR-0005 — The graph store had to earn it, and did not

## Problem

Permission inheritance is a graph. Teams nest, resources nest, and a check is a
multi-hop reachability question across both. That is the textbook case for a
graph database, and the plan this repository was built from named Neo4j on
exactly those grounds — with the condition that it be **measured against a
recursive CTE rather than asserted to beat it**.

## The measurement

`bench/graph-vs-cte.ts`. Both stores implement the same `ReachabilityStore`
interface and the benchmark calls the same method the API calls, so neither is
being invoked specially. The relational side is fully indexed. The two are
checked for agreement before either is timed — a faster wrong answer is not a
result.

The hard case is a **deny**: an allow can stop at the first grant it finds, a
deny has to exhaust the search space.

```
                                            allow (p50/p95)     deny (p50/p95)
shape    depth   grants        cte            graph          cte          graph
shallow    2/2    1,000    0.51/0.87       1.66/3.10     0.40/0.56    1.06/2.19
medium     5/6   10,000    0.43/0.52       1.02/1.63     0.38/0.51    0.89/1.33
deep     10/12   40,000    0.58/0.95       0.79/1.30     0.36/0.46    0.96/1.76
unreal   20/25  200,000    0.94/1.10       0.65/0.95     0.38/0.51    1.33/2.05
```

Milliseconds, 300 iterations per cell, on one laptop.

## Decision

Neo4j is not in the serving path.

The curves do cross, and the honest reading is not "Postgres always wins". At
`unreal` — a team hierarchy 20 deep and a resource tree 25 deep — Cypher wins
the allow case, 0.65 against 0.94. Index-free adjacency does what it says as
depth grows.

But `unreal` is not a shape an organisation produces. At every shape that does
occur, up to and including `deep`, the recursive CTE wins or ties on allow and
wins the deny case outright, at every size. And the deny case is the one that
matters most: it is the majority of a permission service's traffic, and it is
the case a graph traversal has to walk furthest to answer.

A second store was going to cost a projection, a projection lag, an ordering
constraint on cache invalidation ([ADR-0003](0003-postgres-is-the-only-truth.md)
has the bug that constraint existed to prevent), a second consistency story, and
a container. The measurement said it would buy nothing back at any size this
domain reaches.

## Rejected

**Keep it for expressiveness.** The Cypher is genuinely better to read — two
variable-length walks and the join between them, eight lines against the CTE's
twenty-five:

```cypher
MATCH (r)-[:CHILD_OF*0..16]->(anc:Resource)<-[g:GRANTED]-(s)
WHERE g.role IN $roles
  AND (s.id = u.id OR (s:Team AND EXISTS {
        MATCH (u)-[:MEMBER_OF]->(t:Team)-[:CHILD_OF*0..16]->(s) }))
```

That is a real advantage and it is not enough. Twenty lines of SQL live in one
file that already has tests around it; a second database lives in the deployment,
the on-call rotation, and every future consistency question.

**Tune it harder and re-run.** Session reuse was tested and is already in the
numbers above where it helps. Beyond that, the argument "it would win if
optimised further" applies equally to the CTE, and at some point continuing to
look for a shape where the answer changes is not measurement.

## Consequence

Five technologies: Postgres, Redis, Redpanda, NestJS, Next.js. Each one is
load-bearing and each can be justified in a sentence that does not mention a CV.

The losing implementation is kept — `Neo4jReachability`, `Neo4jProjector`, and
Neo4j behind a `bench` compose profile — so this decision can be re-run rather
than re-argued:

```bash
npm run bench:graph
```

If the shape of the problem ever changes, that command is the thing that says so.
