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

CREATE TABLE backup_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT '',
  source_revision TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'staged',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  lease_id TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  drive_file_id TEXT NOT NULL DEFAULT '',
  compressed_sha256 TEXT NOT NULL DEFAULT '',
  compressed_bytes INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  archived_folder_id TEXT NOT NULL DEFAULT '',
  UNIQUE (library_id, request_id),
  UNIQUE (library_id, source_key)
);
CREATE INDEX backup_checkpoints_history ON backup_checkpoints (library_id, created_at, id);

CREATE TABLE backup_restores (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  expected_revision TEXT NOT NULL,
  manifest TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  counts TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_revision TEXT NOT NULL DEFAULT '',
  pre_restore_checkpoint_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX backup_restores_history ON backup_restores (library_id, created_at, id);

CREATE TABLE image_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  file_id_hash TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX image_uploads_request ON image_uploads (owner_id, request_id);
CREATE INDEX image_uploads_expiry ON image_uploads (owner_id, expires_at);
