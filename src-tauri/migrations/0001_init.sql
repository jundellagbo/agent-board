-- Schema v1. Forward-only: never edit a shipped migration, add the next file.
-- Ids are UUID text, timestamps are ISO-8601 UTC text.

CREATE TABLE organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  -- Command template run in a PTY. Placeholders: {prompt} {task} {skill} {path}.
  command     TEXT NOT NULL,
  env         TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  is_git        INTEGER NOT NULL DEFAULT 0,
  use_worktrees INTEGER NOT NULL DEFAULT 1,
  index_status  TEXT NOT NULL DEFAULT 'none',   -- none | indexing | indexed | error
  indexed_at    TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, path)
);
CREATE INDEX idx_projects_org ON projects(org_id, position);

-- A group is a board column: what kind of column it is, what the agent runs for
-- cards in it, and where a card goes when that run ends. The routing columns are
-- what let the auto-runner stay generic instead of hard-coding column names.
CREATE TABLE board_groups (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  board_type    TEXT NOT NULL,                  -- todo | in_progress | review | done | custom
  position      INTEGER NOT NULL DEFAULT 0,
  auto_run      INTEGER NOT NULL DEFAULT 0,     -- runner claims cards that land here
  skills        TEXT NOT NULL DEFAULT '[]',     -- json array of skill names
  command       TEXT,                           -- overrides the agent's template
  prompt        TEXT,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  running_group_id TEXT REFERENCES board_groups(id) ON DELETE SET NULL,
  success_group_id TEXT REFERENCES board_groups(id) ON DELETE SET NULL,
  failure_group_id TEXT REFERENCES board_groups(id) ON DELETE SET NULL,
  wip_limit     INTEGER,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_groups_project ON board_groups(project_id, position);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id      TEXT NOT NULL REFERENCES board_groups(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  -- Set when the card came from a GitHub issue or PR url pasted on create.
  github_url    TEXT,
  github_kind   TEXT,                           -- issue | pull
  github_number INTEGER,
  branch        TEXT,
  worktree_path TEXT,
  run_state     TEXT NOT NULL DEFAULT 'idle',   -- idle | queued | running | done | failed
  last_run_id   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tasks_group ON tasks(group_id, position);
CREATE INDEX idx_tasks_project ON tasks(project_id);

-- One row per agent invocation, kept after the PTY dies so a card shows history.
CREATE TABLE task_runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
  group_id    TEXT REFERENCES board_groups(id) ON DELETE SET NULL,
  command     TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | exited | killed | error
  exit_code   INTEGER,
  log_path    TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX idx_runs_task ON task_runs(task_id, started_at DESC);

CREATE TABLE mcp_installs (
  id           TEXT PRIMARY KEY,
  catalog_key  TEXT NOT NULL,                   -- entry in the built-in catalog
  kind         TEXT NOT NULL DEFAULT 'mcp',     -- mcp | skill
  scope        TEXT NOT NULL DEFAULT 'global',  -- global | project
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'installed',
  config       TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (catalog_key, scope, project_id)
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
