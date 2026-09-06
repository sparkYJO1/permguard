# ADR-0005 — The graph store had to earn it (superseded)

**Superseded by [ADR-0007](0007-two-knowledge-graphs-measured-properly.md).**

This ADR removed Neo4j from the repository on the strength of a benchmark. The
benchmark was wrong, in three separate ways, and every one of them was mine:

1. **It measured one question.** Only the boolean check — the question that
   stops at the first path it finds, which is the shape a relational index scan
   is best at and the shape that wastes a graph traversal. The three questions a
   graph store is actually for were not measured because the code to answer them
   did not exist.
2. **The Cypher walked the wrong way.** Driven from the resource, where the
   graph has hundreds of incoming edges per node, instead of from the user,
   where it has a handful of outgoing ones. Same engine, same data, same answer:
   142ms against 2.3ms.
3. **A property index made it slower.** One was later added on `GRANTED.role` in
   the name of fairness, and it cost 35x, because in a graph store adjacency is
   the index and a property index competes with it.

The conclusion — five honest technologies over six forced ones — was the right
*rule*. It was applied to a measurement that did not support it.

The original text is kept below rather than deleted, because a decision record
that quietly rewrites itself is worth less than one that shows what it got
wrong.

---

## Original problem

Permission inheritance is a graph. Teams nest, resources nest, and a check is a
multi-hop reachability question across both. The plan named Neo4j on exactly
those grounds, with the condition that it be measured against a recursive CTE
rather than asserted to beat it.

## Original decision

Neo4j is not in the serving path. At every shape an organisation produces, the
recursive CTE won or tied on the boolean check and won the deny case outright.
A second store would have cost a projection, a projection lag, an ordering
constraint on cache invalidation, and a container, and the measurement said it
would buy nothing back.

## Why that reasoning failed

The measurement covered `check` and nothing else. `check` is one of four
questions this system gets asked and the only one where stopping early is
allowed. ADR-0007 measures all four, on two property graphs holding identical
data, with the Cypher written by someone who had by then learned which end to
start from — and the answer inverts.
