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

Three independent runs, all committed under [`ops/measurements/`](../../ops/measurements/),
because one run of this benchmark is not a result: cell to cell the numbers move
by a factor of two.

The first run had Neo4j winning all four questions at the largest shape. The
next two did not reproduce that, and the honest table is the intersection.
At `large` — 180 users, 25,001 grants — across all three runs:

| | Neo4j | Postgres KG | verdict |
|---|---|---|---|
| **Q2 why** | 0.82 – 1.56 | 3.26 – 3.44 | Neo4j, 2–4x |
| **Q4 blast** | 32.2 – 34.0 | 81.0 – 92.6 | Neo4j, ~2.5x |
| Q3 who | 20.3 – 21.4 | 21.7 – 23.8 | tie |
| Q1 check | 0.95 – 2.29 | 1.90 – 2.09 | noise; relational wins both at 0.88 – 1.09 |

The two Neo4j wins are the two questions with **no early exit and a backward
walk**. That is not a coincidence and it is the only part of this worth
generalising.

The slope is the robust result. From `small` to `large` the graph grows 50x:

| | Postgres KG | Neo4j |
|---|---|---|
| Q4 blast | 2.5 → 81–93 ms (~30x) | 2.9 → 32–34 ms (~6–11x) |
| Q2 why | 1.2 → 3.3–3.4 ms (~2.6x) | 1.3 → 0.8–1.6 ms (flat or better) |

Traversal cost tracking the neighbourhood rather than the database is what a
graph store claims, and it is what shows up. A recursive CTE cannot do it,
because every level of the recursion is a join against a table that is still
growing.

## Decision

**Six technologies. Neo4j is back, and it serves the traversals.**

- `/check` — the hot path — stays on the **normalized relational** schema. It is
  fastest at every size (0.73ms at `large`), it is the source of truth, and it
  is behind two cache tiers anyway.
- `/explain` is served by **Neo4j** — Q2, where it wins 2–4x and its lead grows
  with the graph.
- `/reachable` is also served by **Neo4j**, and this one is a judgement call
  rather than a measurement: Q3 is a tie. It is routed there for consistency
  with `/explain` and because the slope favours it as graphs grow, not because
  the numbers demand it today.
- `/impact` is served by **pg-kg**, even though Neo4j is ~2.5x faster at it.
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

**Serve everything from Neo4j.** It wins two of the four questions outright and
ties a third, so this looks obvious. Rejected because the boolean check is the hot path, the
relational schema is fastest at it, and that schema is the source of truth —
routing the most frequent question through a projection would add staleness to
the one answer that must not have any.

**Drop pg-kg now that Neo4j is justified.** Rejected for two reasons. It is
written in the grant's own transaction, which makes it the only store that can
answer `/impact` correctly. And it is the fallback that makes a Neo4j outage a
latency problem instead of a feature outage — which is a claim this repository
can now make honestly, because the numbers behind it are in this file.

**Trust the first benchmark.** It is worth naming as a rejected option twice
over, because it was the default both times. First it was a single-question
benchmark with a 60x query-direction error and a 35x index error, all pointing
the same way, and deleting a database felt rigorous because it had a table
attached. Then the corrected benchmark was run once and quoted, and two of its
four cells did not survive being re-run. A number is not a measurement until it
repeats.

## Consequence

Six technologies, each defensible in one sentence, and one of them is defensible
only because the first attempt to defend it was wrong in a way that took three
separate measurements to find.

`pnpm run bench:kg` re-runs the comparison. `pnpm run bench:direction` re-runs the
60x. Both restore the demo data on a clean exit.
