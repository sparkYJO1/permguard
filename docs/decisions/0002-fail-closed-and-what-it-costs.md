# ADR-0002 — Fail closed, and say what that costs

## Problem

Postgres is unreachable and a decision is not in either cache. What does
`/check` return?

## Decision

Deny, with `reason: "unavailable"` and `source: "none"`, so the caller can tell
"no path exists" apart from "I could not find out".

The `unavailable` deny is never written to either cache. Caching it would let a
transient outage produce denials that outlive the outage — the failure mode
where the database comes back and the system stays broken for another five
minutes for reasons nobody can see.

Redis is treated differently and deliberately so. Every cache call is wrapped so
that a failure falls through to computing the answer. Losing Redis costs latency
and nothing else; the node keeps answering, correctly, slower. `/health` reports
Redis separately and `ok` tracks Postgres alone, because taking a node out of
rotation for a problem it can absorb is a worse outage than the problem.

## Rejected

**Serve the last known answer when the store is unreachable.** Proposed on the
grounds that availability matters and a permission usually has not changed. It
was rejected because "usually has not changed" is doing all the work in that
sentence, and the case where it has changed is precisely a revoke that someone
needed to take effect. A permission system that guesses under failure has turned
an outage into an incident.

**Fail open for read, closed for write.** Superficially attractive, and it is
what a lot of systems quietly do. Rejected because it means the sentence "this
service denies when it cannot verify" becomes false, and a security property you
have to qualify is one you cannot rely on. If read-availability during a
Postgres outage genuinely mattered more than correctness, the honest way to say
so is a separate endpoint with a different name — not a flag that changes what
`/check` means.

## Consequence

A Postgres outage takes the service down for anything not already cached. That
is stated rather than mitigated: the caches keep it partially useful, and there
is no fallback path that would make it look healthier than it is.

The unit tests assert this directly, including the one that would be easiest to
regress by accident — that an `unavailable` deny leaves both caches empty.
