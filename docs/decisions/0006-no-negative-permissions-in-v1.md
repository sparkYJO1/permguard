# ADR-0006 — No negative permissions, and why that is the harder choice

## Problem

Should a grant be able to say *no*? "Everyone in Engineering can write to
repo-core, **except** contractors" is a thing organisations actually want.

## Decision

Not in v1. A grant only ever adds.

## Why this is a decision and not an omission

With positive grants only, a check is reachability: does a path exist? The
answer does not depend on which path is found, so the query can stop at the
first one — which is why `LIMIT 1` is correct in both implementations and why
the deny case is the only expensive one.

Add negative grants and that collapses. The check can no longer stop early,
because a deny found later must override an allow found earlier. Worse, it needs
a rule for *which* one wins, and every available rule is defensible and
different:

- **Deny always wins.** Simple, and it means one deny anywhere in an ancestor
  chain silently removes access that was granted three levels closer to the
  resource.
- **Most specific wins.** Matches intuition, and requires defining "specific"
  across two independent hierarchies that can disagree — a deny on a parent team
  against an allow on a child resource has no natural ordering.
- **Explicit beats inherited.** Needs every grant to carry its distance from the
  subject, which the cache key does not currently model.

None of those is wrong. That is the problem: the choice is invisible in the API
and enormous in its consequences, and a permission system whose conflict
resolution cannot be stated in one sentence is one nobody can reason about
during an incident.

## Rejected

**Support it behind a flag and pick a default.** Rejected because the default
becomes the behaviour and the flag becomes documentation nobody reads. If deny
rules are added later they should change what a check *means*, visibly, with the
resolution rule in the type — not appear as an option.

## Consequence

Some real policies cannot be expressed. The workaround is to model exclusion as
team membership rather than as a negative grant — take the contractors out of
Engineering rather than denying them inside it — which is more restructuring
than a deny rule, and is legible in the graph on the front page.

If this is revisited, the thing to write first is the conflict-resolution rule
and its test matrix, not the schema change.
