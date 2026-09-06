# ADR-0007 — Two knowledge graphs, measured properly

## Problem

[ADR-0005](0005-the-graph-store-had-to-earn-it.md) deleted Neo4j from this
repository after benchmarking one question. This is the re-measurement: four
questions, two stores holding the same graph in the same shape, and Cypher
written by someone who had made every mistake in it at least once.

## What is being compared

Two property graphs, not a graph store against a schema shaped for a different
question — that asymmetry was part of what made the first attempt meaningless.

| | |
|---|---|
| **pg-kg** | `kg_nodes` / `kg_edges` in Postgres. Generic, indexed both ways, traversed by recursive CTE. Written *in the same transaction as the grant*, so it is never stale |
| **neo4j** | The same nodes and edges. A projection fed from the event stream, so it can be behind by the invalidation window |
| **relational** | The normalized `grants` / `memberships` / `teams` tables. Kept on Q1 only, because it is what serves the hot path |

Four questions, chosen because the first attempt only asked the easiest one:

| | | |
|---|---|---|
| **Q1 check** | can this user do this here | forward, stops at the first path |
| **Q2 why** | every path that grants it | forward, no early exit |
| **Q3 who** | everyone who can reach this resource | **backward** |
| **Q4 blast** | who loses access if this grant goes | backward, plus a subtraction |

Both engines are called through one interface, and `bench/kg-engines.ts` asserts
they return identical sets before timing anything.

## The measurement

```
                                          p50 / p95 ms

small   depth 3/3    21 users     501 grants
  Q1 check   pg-kg  2.10/ 6.22   neo4j  1.62/ 3.33   (relational 0.91/2.20)
  Q2 why     pg-kg  1.86/ 2.53   neo4j  1.09/ 2.40
  Q3 who     pg-kg  1.73/ 2.21   neo4j  2.57/ 5.91
  Q4 blast   pg-kg  2.95/ 3.37   neo4j  2.52/ 4.35

medium  depth 5/6    68 users   5,001 grants
  Q1 check   pg-kg  1.26/ 2.22   neo4j  1.19/ 2.88   (relational 0.96/1.41)
  Q2 why     pg-kg  1.90/ 5.35   neo4j  1.18/ 2.49
  Q3 who     pg-kg  4.87/ 6.58   neo4j  5.33/ 6.67
  Q4 blast   pg-kg 12.13/14.23   neo4j  8.21/11.73

large   depth 8/10  180 users  25,001 grants
  Q1 check   pg-kg  2.09/ 3.44   neo4j  0.95/ 2.15   (relational 0.73/1.72)
  Q2 why     pg-kg  3.26/ 5.21   neo4j  0.82/ 1.62
  Q3 who     pg-kg 23.82/48.91   neo4j 20.28/26.63
  Q4 blast   pg-kg 92.59/137.20  neo4j 33.28/40.51
```

The absolute numbers matter less than the slope. From `small` to `large` the
graph grows 50x in grants:

- **Q4 blast**: pg-kg 2.95 → 92.59 (31x). Neo4j 2.52 → 33.28 (13x).
- **Q2 why**: pg-kg 1.86 → 3.26. Neo4j 1.09 → **0.82** — flat, and slightly
  faster on the larger graph.

That is index-free adjacency behaving as advertised: traversal cost tracks the
size of the neighbourhood walked, not the size of the database. The recursive
CTE cannot do that, because every level of the recursion is a join against a
table that is still growing.

## Decision

**Six technologies. Neo4j is back, and it serves the traversals.**

- `/check` — the hot path — stays on the **normalized relational** schema. It is
  fastest at every size (0.73ms at `large`), it is the source of truth, and it
  is behind two cache tiers anyway.
- `/explain` and `/reachable` are served by **Neo4j**, which wins them and wins
  by more as the graph grows.
- `/impact` is served by **pg-kg**, even though Neo4j is 2.8x faster at it.
  This is the one traversal whose answer is acted on immediately — someone is
  about to revoke a grant — and answering it from a projection that may be tens
  of milliseconds behind means answering about a graph that is not the one being
  changed. The slower store is the correct one here.

Every response says which engine answered and whether that engine could have
been stale.

## Three mistakes, and what they were worth

Kept because they are the useful part.

**Walking from the wrong end — 60x.** `bench/cypher-direction.ts` measures it:
the same boolean check is 142ms driven from the resource and 2.3ms driven from
the subject. The resource end has hundreds of incoming `GRANTED` edges per node;
the user end has a handful of outgoing ones, and Neo4j walks whatever you point
it at. Postgres never had to choose — the SQL builds both closures and lets the
planner drive from whichever is cheaper. That is a real difference between the
two, and it is about *where the expertise has to live*, not about what the
engines can do.

**A property index — 35x, backwards.** An index on `GRANTED.role` was added to
match the `(dst, role)` index Postgres has, because giving one store a targeted
index and not the other seemed unfair. The check went from 1.34ms to 47ms. The
plan says why: `DirectedRelationshipIndexSeek` pulled 175,008 relationships
matching the role list and filtered them against a nine-element subject set
whose cardinality the planner could not estimate. In a graph store adjacency
*is* the index; a property index on a relationship competes with it. Postgres's
compound `(dst, role)` index supports a join, which is a different thing wearing
a similar name. The index is now explicitly dropped, with the measurement in the
comment.

**A projection that only added.** `Neo4jProjector.syncTopology` used to MERGE
and never delete, so a node removed in Postgres stayed in the graph forever. In
the demo that was invisible because the topology only grew. In the benchmark it
was not: one shape's users survived into the next shape's run, and the agreement
assertion caught the two stores answering `who` differently. A projection is
rebuilt, not patched.

## Rejected

**Serve everything from Neo4j.** It wins three of the four questions, so this
looks obvious. Rejected because the boolean check is the hot path, the
relational schema is fastest at it, and that schema is the source of truth —
routing the most frequent question through a projection would add staleness to
the one answer that must not have any.

**Drop pg-kg now that Neo4j is justified.** Rejected for two reasons. It is
written in the grant's own transaction, which makes it the only store that can
answer `/impact` correctly. And it is the fallback that makes a Neo4j outage a
latency problem instead of a feature outage — which is a claim this repository
can now make honestly, because the numbers behind it are in this file.

**Trust the first benchmark.** It is worth naming as a rejected option, because
it was the default. A single-question benchmark, a 60x query-direction error and
a 35x index error all pointed the same way, and the resulting decision — delete
a database — felt rigorous because it had a table attached to it.

## Consequence

Six technologies, each defensible in one sentence, and one of them is defensible
only because the first attempt to defend it was wrong in a way that took three
separate measurements to find.

`npm run bench:kg` re-runs the comparison. `npm run bench:direction` re-runs the
60x. Both restore the demo data on a clean exit.
