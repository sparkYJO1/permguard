# ADR-0003 — Postgres is the only truth

> **Amended by [ADR-0007](0007-two-knowledge-graphs-measured-properly.md).** The
> title of this ADR used to end "and that is why there is no read model". There
> is one again — Neo4j serves the traversal endpoints — but the rule below did
> not change: Postgres is still the only source of truth, and the ordering bug
> recorded here is still why cache invalidation is not chained behind the
> projector.

## Problem

Where do grants live, and what answers a check?

The original design had two stores: Postgres holding grants and audit, and Neo4j
holding a graph projection that the check actually read. That shape raises the
question this ADR exists to answer — when the projection is behind the source of
truth, which one wins, and what happens in between.

## Decision

Postgres holds everything and answers the **check** directly. The check has no
read model in front of it, so no projection lag can affect the one answer that
is on the hot path and behind two caches.

The traversal endpoints do have a read model — Neo4j — and it is allowed to lag,
because `/explain` being 30ms behind is a different kind of wrong from `/check`
being 30ms behind. Which one answered is on every response.

## The bug that made the original design wrong

Worth writing down, because it is subtle, it was found by reasoning about
ordering rather than by a test failing, and it is the reason invalidation is
still not routed through the projector even now that the projector is back.

With a graph read model, the obvious wiring is: revoke commits → event published
→ every node evicts its cache. That is wrong. A node that evicts on
`GrantRevoked` will take the next request, miss, read a graph that has *not yet
applied the revoke*, and cache the old answer — under the new generation. The
revoke then stays invisible until a TTL expires, and the invalidation event has
made things worse than doing nothing.

The fix was to chain: the projector applies the change to the graph, then
publishes `ProjectionApplied`, and only that triggers eviction. It worked. It
also added a hop to the middle of the number this repository publishes.

Taking the graph out of the *invalidation path* removed the hop, the ordering
constraint, and the class of bug, and the measured window improved from p95
67ms to p95 51ms. The graph store came back later (ADR-0007) but the
invalidation path did not change: API nodes consume `authorization.events`
directly and the projector consumes the same topic independently. Nothing waits
for the projection, so nothing can be re-cached from a stale one.

## Rejected

**Keep the graph as a read model *for the check*, with chained invalidation.**
It was implemented and working. Rejected because the chain puts the projector
inside the invalidation window, and the check does not need the graph: the
relational schema is fastest at it at every size measured (ADR-0007). The graph
came back for the questions that do need it, on a path where lag is acceptable
and reported.

**Dual-write to both stores.** Rejected before it was built. Two writes cannot be
made atomic without a transaction spanning both, and the alternative — write
Postgres, then write Neo4j — has a window where they disagree and no way to
detect it. The outbox exists precisely so that the second write is a consequence
of the first rather than a peer of it.

## Consequence

The check answers from the source of truth and cannot be stale. Audit keeps its own table rather than
reading `grants`, which is the one place a second copy of a fact is allowed
here: a revoke deletes the grant row, and "who held this and when was it taken
away" has to outlive the row it describes.

The cost is that two stores can disagree about the traversal answers for the
length of an invalidation window. That is why `/explain` and `/reachable` report
`authoritative: false` and `/impact` — the one whose answer is acted on
immediately — is served from the store that cannot lag.
