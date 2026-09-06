# ADR-0004 — Every answer says where it came from

## Problem

`/check` returns a boolean. A boolean is unfalsifiable after the fact: when
someone reports that a revoked user still had access at 14:32, there is nothing
to look at.

## Decision

Every decision carries `source` (`l1`, `l2`, `relational`, or `none`), `atSeq`
(the generation it was computed under), `reason`, and on the wire also `node` and
`latencyMicros`. Not behind a debug flag — on every response, including the
ones that say yes.

This is what makes the invalidation window observable rather than theoretical.
Two nodes reporting different `atSeq` for the same question are two nodes about
to disagree, and you can see it happening. The benchmark and the UI are both
built on nothing more than this field.

## Rejected

**Put it behind `?explain=1`.** Proposed to keep the hot response small. Rejected
because the field is only useful in the incident, and the incident is exactly
when nobody thinks to add the flag. Four small fields on a JSON response is not
a cost worth optimising against the ability to answer "which node, from which
cache, at which generation".

## Consequence

The response is slightly larger and slightly more coupled to the internals —
`source: "l2"` names a caching tier in a public API. That is accepted: the
alternative is a permission service whose answers cannot be attributed, and the
coupling is to a concept (a decision came from somewhere, at some version) that
is stable even if the tiers change.
