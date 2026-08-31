-- LocalCast initial schema.
--
-- Every table the product will ever need is declared here, even the ones later phases fill,
-- so that a phase-6 feature never has to migrate a database that phase-1 users are already
-- carrying data in.
--
-- Times are unix milliseconds. Ids are uuid v4 text unless noted.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── identity ─────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  platform          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  -- Bumping this invalidates every access token already issued to the device. This is what
  -- makes the panel's "بستن" button take effect on the next request instead of at expiry.
  token_version     INTEGER NOT NULL DEFAULT 1,
  -- scrypt hash of the generated WebDAV Basic-auth password. The plaintext is shown once at
  -- pairing time and never stored.
  dav_password_hash TEXT,
  refresh_hash      TEXT,
  refresh_expires_at INTEGER,
  last_seen_at      INTEGER,
  last_peer         TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_devices_status ON devices(status);

-- ── library ──────────────────────────────────────────────────────────────────

CREATE TABLE shared_folders (
  id              TEXT PRIMARY KEY,
  -- Absolute, normalised, long-path form. Unique so a folder cannot be added twice under
  -- two labels and end up with two conflicting permission rows.
  path            TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('video', 'documents', 'photos', 'mixed')),
  writable        INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- 0 when the drive is unplugged. The folder stays listed and greyed rather than vanishing,
  -- so a permission grant is not silently lost when someone unplugs an external disk.
  available       INTEGER NOT NULL DEFAULT 1,
  auto_index      INTEGER NOT NULL DEFAULT 1,
  last_indexed_at INTEGER,
  file_count      INTEGER,
  total_bytes     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE folder_permissions (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES shared_folders(id) ON DELETE CASCADE,
  mode      TEXT NOT NULL CHECK (mode IN ('full', 'stream', 'none')),
  PRIMARY KEY (device_id, folder_id)
) WITHOUT ROWID;

-- An index over the shared folders, used for listing, counts and search ONLY. It is never
-- the source of truth: anything that serves bytes re-resolves and re-stats the real path, so
-- a stale row can show a file that has gone but can never cause the wrong file to be served.
CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  folder_id    TEXT NOT NULL REFERENCES shared_folders(id) ON DELETE CASCADE,
  -- POSIX-separated and relative to the folder root, even on Windows.
  rel_path     TEXT NOT NULL,
  parent_path  TEXT NOT NULL,
  name         TEXT NOT NULL,
  is_dir       INTEGER NOT NULL,
  size         INTEGER,
  mtime        INTEGER,
  ext          TEXT,
  media_kind   TEXT NOT NULL DEFAULT 'other',
  printable    INTEGER NOT NULL DEFAULT 0,
  -- Whether Safari can play it directly. False for MKV, H.265 and AC3/DTS payloads; those
  -- get the native-player handoff instead of a black video element.
  browser_playable INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL,
  UNIQUE (folder_id, rel_path)
);

CREATE INDEX idx_files_listing ON files(folder_id, parent_path, is_dir, name);

CREATE VIRTUAL TABLE files_fts USING fts5(
  name,
  content = 'files',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER files_fts_insert AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;
CREATE TRIGGER files_fts_update AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
END;

-- ── pairing ──────────────────────────────────────────────────────────────────

CREATE TABLE pairing_tokens (
  id                  TEXT PRIMARY KEY,
  -- 4 characters from an unambiguous alphabet, shown on screen 03 as the manual fallback.
  code                TEXT NOT NULL UNIQUE,
  -- scrypt hash of the 32-byte secret carried in the QR. The secret is what makes the QR
  -- unguessable; the code alone is guarded by the rate limiter and a 5-failure lockout.
  secret_hash         TEXT NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_at           INTEGER,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER,
  consumed_by_device  TEXT REFERENCES devices(id) ON DELETE SET NULL,
  -- JSON snapshot of the default folder modes as they were when the code was minted, so a
  -- later change to the defaults does not retroactively widen an outstanding invitation.
  default_permissions TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_pairing_expiry ON pairing_tokens(expires_at);

-- ── network ──────────────────────────────────────────────────────────────────

CREATE TABLE network_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  mode           TEXT NOT NULL CHECK (mode IN ('default', 'custom')),
  control_url    TEXT,
  -- DPAPI-encrypted via Electron safeStorage. Never plaintext, never logged.
  auth_key_enc   TEXT,
  expose         TEXT NOT NULL DEFAULT 'tailnet' CHECK (expose IN ('tailnet', 'funnel')),
  cert_strategy  TEXT NOT NULL CHECK (cert_strategy IN ('control-plane', 'external-proxy', 'dns01')),
  cert_domain    TEXT,
  dns_provider   TEXT,
  dns_token_enc  TEXT,
  hostname       TEXT NOT NULL DEFAULT 'localcast',
  updated_at     INTEGER NOT NULL
);

-- ── printing ─────────────────────────────────────────────────────────────────

CREATE TABLE printers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  driver          TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0,
  color_capable   INTEGER NOT NULL DEFAULT 0,
  duplex_capable  INTEGER NOT NULL DEFAULT 0,
  status          TEXT,
  online          INTEGER NOT NULL DEFAULT 1,
  -- The operator can hide a printer from every client without removing it from Windows.
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_seen_at    INTEGER NOT NULL
);

CREATE TABLE print_jobs (
  id             TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  printer_id     TEXT NOT NULL REFERENCES printers(id) ON DELETE RESTRICT,
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('library', 'upload')),
  source_path    TEXT,
  -- The temp copy actually handed to the spooler. Deleted once the job leaves the queue.
  spool_path     TEXT,
  file_name      TEXT NOT NULL,
  copies         INTEGER NOT NULL DEFAULT 1,
  color          TEXT NOT NULL DEFAULT 'mono' CHECK (color IN ('color', 'mono')),
  duplex         TEXT NOT NULL DEFAULT 'simplex' CHECK (duplex IN ('simplex', 'long', 'short')),
  page_range     TEXT,
  status         TEXT NOT NULL CHECK (status IN ('queued', 'printing', 'done', 'error', 'cancelled')),
  error_message  TEXT,
  -- The real spooler job id. "done" means Get-PrintJob said so, not that a process exited 0.
  windows_job_id INTEGER,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);

CREATE INDEX idx_print_jobs_device ON print_jobs(device_id, created_at DESC);
CREATE INDEX idx_print_jobs_active ON print_jobs(status) WHERE status IN ('queued', 'printing');

-- ── uploads (surface 4) ──────────────────────────────────────────────────────

CREATE TABLE uploads (
  id              TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  folder_id       TEXT NOT NULL REFERENCES shared_folders(id) ON DELETE CASCADE,
  rel_path        TEXT NOT NULL,
  total_bytes     INTEGER NOT NULL,
  received_bytes  INTEGER NOT NULL DEFAULT 0,
  chunk_size      INTEGER NOT NULL,
  temp_path       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active', 'complete', 'aborted')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_uploads_device ON uploads(device_id, status);

-- ── activity (the "فعالیت" tab) ──────────────────────────────────────────────

CREATE TABLE activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  kind      TEXT NOT NULL,
  detail    TEXT
);

CREATE INDEX idx_activity_at ON activity(at DESC);
