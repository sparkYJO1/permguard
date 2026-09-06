-- A property graph, in Postgres.
--
-- This is the other half of the comparison in ADR-0007: the same graph the
-- Neo4j projection holds, stored generically rather than as the normalized
-- `users` / `teams` / `memberships` / `resources` / `grants` tables next door.
--
-- The point of storing it this way rather than reusing the normalized schema is
-- that it is the same *shape* as the graph database. A traversal here walks
-- edges by label exactly as Cypher does, so what the benchmark compares is the
-- engine and the storage model, not one schema that happens to fit the question
-- against another that does not.

CREATE TABLE IF NOT EXISTS kg_nodes (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('User', 'Team', 'Resource')),
  props JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS kg_nodes_label_idx ON kg_nodes(label);

CREATE TABLE IF NOT EXISTS kg_edges (
  id   BIGSERIAL PRIMARY KEY,
  src  TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  rel  TEXT NOT NULL CHECK (rel IN ('MEMBER_OF', 'CHILD_OF', 'GRANTED')),
  dst  TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  props JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (src, rel, dst, props)
);

-- Both directions are indexed, and that is the whole argument for this table
-- existing. Forward gets you `check` and `why`; reverse gets you `who` and
-- `blastRadius`, which the normalized schema can only answer by scanning
-- `grants` and joining back out. A graph store's claim is that traversal is
-- symmetric; this is what makes that claim testable in Postgres.
CREATE INDEX IF NOT EXISTS kg_edges_out_idx ON kg_edges(src, rel);
CREATE INDEX IF NOT EXISTS kg_edges_in_idx  ON kg_edges(dst, rel);

-- Role lives in `props` to keep the edge table generic, so it needs its own
-- index or every GRANTED traversal re-parses JSON for the filter.
CREATE INDEX IF NOT EXISTS kg_edges_granted_role_idx
  ON kg_edges(dst, (props->>'role')) WHERE rel = 'GRANTED';
