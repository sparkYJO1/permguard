# ADR-0001 — Active invalidation, with a poll underneath it

## Problem

A permission is revoked. Every node holds cached decisions computed before the
revoke. How do those stop being served?

There are two answers and they are usually presented as alternatives. Wait for a
TTL to expire: simple, and the staleness window is the TTL, which for a
permission cache is an unacceptable number to write down. Or push an
invalidation event: fast, and it makes a lost message into a permanent security
hole rather than a delayed one.

## Decision

Both. Events are the fast path and a poll is the floor.

Each node consumes `authorization.events` into a consumer group of its own and
advances a **generation** — the outbox id of the most recent authorization
write. The generation is part of every cache key, so a node that has learned
generation *N+1* cannot construct a key that reaches anything cached under *N*.
Nothing is deleted; the old entries simply stop being addressable and fall out
of memory on their own.

Underneath that, `OutboxGeneration.start()` re-reads `max(outbox.id)` from
Postgres every `GENERATION_BACKSTOP_MS` (default 5000). Nothing about
correctness depends on the broker.

So there are two numbers, and the README publishes both:

| | |
|---|---|
| Event path, measured | p50 **34 ms**, p95 **51 ms** |
| Backstop, if the event never arrives | **5000 ms** |

The second one is the honest worst case. Publishing only the first would be
describing a system that has never lost a message.

## Rejected

**Evict the affected keys instead of bumping a generation.** This was the first
proposal and it is the obvious design. It does not work here: computing the set
of affected keys means answering "which users could reach this resource" — the
check query run backwards — and running it against the graph *as it was before
the change*, which no longer exists. Precise eviction of an inherited-permission
cache is a reverse traversal at revoke time with no bound on its size. The
generation counter is the blunt instrument, and its cost is stated below rather
than hidden.

**Trust the events alone and drop the poll.** Rejected because the failure is
silent and permanent. A dropped message with no backstop means one node serves a
revoked permission until it restarts, and nothing in the system reports that it
is doing so.

## Consequence

Every permission change invalidates the entire decision cache, cluster-wide.
That is a real cost: after any grant or revoke, the next request for every
distinct question pays a fresh recursive CTE. At the scale this repository
demonstrates it is invisible; on a system with a high write rate it would not
be, and the fix — a generation per resource subtree, since a grant always lands
on exactly one resource — is deliberately not implemented, because it adds a
lookup to the hot path and there is no measurement here that justifies it yet.

The knob that matters most is not in this decision at all. The dominant term in
the measured window is the outbox relay's poll interval: at `OUTBOX_POLL_MS=5`
the window is p50 9 ms, at 50 it is p50 34 ms, at 200 it is p50 121 ms. The
window is approximately *U(0, poll interval) + 4 ms*.
