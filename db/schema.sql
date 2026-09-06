-- Postgres is the source of truth for every fact in this system. Neo4j holds a
-- projection of the subset needed to answer reachability, and Redis holds
-- decisions derived from that projection. Neither can produce a fact that is
-- not here first. See ADR-0003.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

-- `parent_id` means "this team sits inside that one". Membership is inherited
-- upward: a member of Platform is a member of Engineering if Platform's parent
-- is Engineering. That direction is a modelling choice, not a law, and the
-- integration tests assert it explicitly so it cannot drift.
CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  parent_id    TEXT REFERENCES teams(id)
);
CREATE INDEX IF NOT EXISTS teams_parent_idx ON teams(parent_id);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

CREATE TABLE IF NOT EXISTS resources (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  parent_id TEXT REFERENCES resources(id)
);
CREATE INDEX IF NOT EXISTS resources_parent_idx ON resources(parent_id);

CREATE TABLE IF NOT EXISTS grants (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'team')),
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  resource_id  TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id, role, resource_id)
);
-- The recursive CTE filters on resource and role first, then on subject. Both
-- indexes exist so the relational implementation is being measured at its best
-- rather than being set up to lose. ADR-0005 depends on that being true.
CREATE INDEX IF NOT EXISTS grants_resource_role_idx ON grants(resource_id, role);
CREATE INDEX IF NOT EXISTS grants_subject_idx ON grants(subject_kind, subject_id);

-- Audit is a separate bounded context and keeps its own record, written from
-- the event stream rather than read out of `grants`. That is deliberate: a
-- revoke deletes the grant row, and "who held this and when was it taken away"
-- has to outlive the row it describes. Append-only, never updated.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  outbox_id    BIGINT NOT NULL UNIQUE,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log(resource_id, id DESC);
