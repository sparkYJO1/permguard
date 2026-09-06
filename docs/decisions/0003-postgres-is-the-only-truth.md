# ADR-0003 — Postgres is the only truth, and that is why there is no read model

## Problem

Where do grants live, and what answers a check?

The original design had two stores: Postgres holding grants and audit, and Neo4j
holding a graph projection that the check actually read. That shape raises the
question this ADR exists to answer — when the projection is behind the source of
truth, which one wins, and what happens in between.

## Decision

Postgres holds everything and answers the check directly. There is no read
model, so there is no projection lag, so the question above does not arise.

That is not the decision that was planned. It is the decision that survived the
measurement in [ADR-0005](0005-the-graph-store-had-to-earn-it.md).

## The bug that the removed design had

Worth writing down, because it is subtle and it was found by reasoning about
ordering rather than by a test failing.

With a graph read model, the obvious wiring is: revoke commits → event published
→ every node evicts its cache. That is wrong. A node that evicts on
`GrantRevoked` will take the next request, miss, read a graph that has *not yet
applied the revoke*, and cache the old answer — under the new generation. The
revoke then stays invisible until a TTL expires, and the invalidation event has
made things worse than doing nothing.

The fix was to chain: the projector applies the change to the graph, then
publishes `ProjectionApplied`, and only that triggers eviction. It worked. It
also added a hop to the middle of the number this repository publishes.

Removing the graph store removed the hop, the ordering constraint, and the class
of bug. The measured window improved from p95 67 ms to p95 51 ms as a side
effect of deleting a database.

## Rejected

**Keep the graph as a read model and accept the chained invalidation.** It was
implemented and working. Rejected once the benchmark showed the graph was not
faster at any realistic shape: a correctness constraint that exists only to
support a component that is not earning its place is a constraint you can delete
along with the component.

**Dual-write to both stores.** Rejected before it was built. Two writes cannot be
made atomic without a transaction spanning both, and the alternative — write
Postgres, then write Neo4j — has a window where they disagree and no way to
detect it. The outbox exists precisely so that the second write is a consequence
of the first rather than a peer of it.

## Consequence

Five technologies instead of six. Audit still keeps its own table rather than
reading `grants`, which is the one place a second copy of a fact is allowed
here: a revoke deletes the grant row, and "who held this and when was it taken
away" has to outlive the row it describes.

`Neo4jReachability` and `Neo4jProjector` are still in the tree, exported, and
not wired into anything. They are what `bench/graph-vs-cte.ts` runs. Deleting
them would make the decision unre-runnable, and a decision you cannot re-derive
in one command is one that gets re-argued from memory in six months.
