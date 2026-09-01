import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from '../kernel.js';
import { silentLogger } from '../logger.js';

export interface OpenDatabaseOptions {
  /** Absolute file path, or `:memory:` for a throwaway database in a test. */
  path: string;
  log?: Logger;
  /** Skip migrations when a caller wants to inspect a raw file. Defaults to false. */
  skipMigrations?: boolean;
  /**
   * Path to a `better_sqlite3.node` built for the host runtime, when it is not the one in
   * `node_modules`.
   *
   * A compiled binding is tied to one ABI, and this project has two hosts: Node runs the
   * tests, Electron runs the app. Rebuilding in place makes them take turns — whichever ran
   * last works and the other dies on `NODE_MODULE_VERSION`. Keeping `node_modules` on Node's
   * ABI and pointing Electron at its own copy lets both work at once.
   */
  nativeBinding?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The `.sql` files are data, not code, so `tsc` does not copy them into `dist`. Rather than
 * bolt a copy step onto a build another agent owns, we look next to the compiled module
 * first and then fall back to the source tree. Both layouts resolve to the same files.
 */
function migrationsDir(): string {
  const candidates = [
    path.join(here, 'migrations'),
    path.join(here, '..', '..', 'src', 'db', 'migrations'),
    path.join(here, '..', '..', '..', 'src', 'db', 'migrations'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`no migrations directory found; looked in ${candidates.join(', ')}`);
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)/.exec(name);
      if (!match?.[1]) throw new Error(`migration ${name} does not start with a number`);
      return {
        version: Number(match[1]),
        name,
        sql: fs.readFileSync(path.join(dir, name), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);
}

function migrate(db: Db, log: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of loadMigrations()) {
    if (applied.has(m.version)) continue;
    // One transaction per migration: a half-applied schema is worse than an unapplied one,
    // and SQLite gives us transactional DDL for free.
    const run = db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
    });
    run();
    log.info('migration applied', { version: m.version, name: m.name });
  }
}

/**
 * The two singleton rows every other subsystem assumes exist. Seeding is idempotent so a
 * restart, or a database restored from backup, converges rather than duplicating.
 */
function seed(db: Db): void {
  const now = Date.now();

  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!owner) {
    db.prepare(
      "INSERT INTO users (id, display_name, role, created_at) VALUES (?, 'Owner', 'owner', ?)",
    ).run(randomUUID(), now);
  }

  const net = db.prepare('SELECT id FROM network_config WHERE id = 1').get();
  if (!net) {
    // `default` + `control-plane` is the only combination that needs nothing from the user,
    // so a fresh install is already in a state the edge can act on.
    db.prepare(
      `INSERT INTO network_config (id, mode, expose, cert_strategy, hostname, updated_at)
       VALUES (1, 'default', 'tailnet', 'control-plane', 'localcast', ?)`,
    ).run(now);
  }
}

export function ownerUserId(db: Db): string {
  const row = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!row) throw new Error('owner user missing; database was not seeded');
  return row.id;
}

export function openDatabase(opts: OpenDatabaseOptions): Db {
  const log = opts.log ?? silentLogger;

  if (opts.path !== ':memory:') {
    fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  }

  const db = opts.nativeBinding
    ? new Database(opts.path, { nativeBinding: opts.nativeBinding })
    : new Database(opts.path);

  // WAL lets the indexer write while a range request reads. `foreign_keys` is per-connection
  // in SQLite and off by default, so the CASCADE rules in the schema are inert without it.
  if (opts.path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // A 5 s wait beats an immediate SQLITE_BUSY when a reindex overlaps a burst of requests.
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  if (!opts.skipMigrations) {
    migrate(db, log);
    seed(db);
  }

  return db;
}
