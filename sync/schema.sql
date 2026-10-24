CREATE TABLE library_heads (
  library_id TEXT PRIMARY KEY NOT NULL,
  revision TEXT NOT NULL DEFAULT ''
);

CREATE TABLE library_commits (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  manifest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'conflict')),
  observed_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (library_id, mutation_id)
);

CREATE INDEX library_commits_history ON library_commits (library_id, created_at, id);
