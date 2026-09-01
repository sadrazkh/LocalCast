import type { Database as Db } from 'better-sqlite3';
import type { ActivityLog, Logger } from './kernel.js';

export interface ActivityEntry {
  id: number;
  at: number;
  deviceId: string | null;
  deviceName: string | null;
  kind: string;
  detail: Record<string, unknown> | null;
}

export interface ActivityLogOptions {
  /** Newest rows kept. The feed is a UI convenience, not an audit trail. */
  cap?: number;
  /** Trim every N writes rather than on every one; the delete walks an index either way. */
  trimEvery?: number;
}

export class SqliteActivityLog implements ActivityLog {
  private writesSinceTrim = 0;
  private readonly cap: number;
  private readonly trimEvery: number;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    opts: ActivityLogOptions = {},
  ) {
    this.cap = opts.cap ?? 5000;
    this.trimEvery = opts.trimEvery ?? 100;
    this.trim();
  }

  /**
   * Never throws. This is called from the middle of request handlers and from the pairing
   * flow; a malformed detail object or a device row that vanished under us must not turn a
   * working request into a 500.
   */
  record(kind: string, deviceId: string | null, detail?: Record<string, unknown>): void {
    let payload: string | null = null;
    try {
      payload = detail ? JSON.stringify(detail) : null;
    } catch {
      payload = null;
    }

    const insert = this.db.prepare(
      'INSERT INTO activity (at, device_id, kind, detail) VALUES (?, ?, ?, ?)',
    );

    try {
      insert.run(Date.now(), deviceId, kind, payload);
    } catch (err) {
      // The only expected failure is the foreign key on a device that has since been
      // deleted. Losing the association is better than losing the entry.
      try {
        insert.run(Date.now(), null, kind, payload);
      } catch (inner) {
        this.log.warn('activity entry dropped', { kind, error: String(inner) });
        return;
      }
      this.log.debug('activity entry recorded without its device', {
        kind,
        error: String(err),
      });
    }

    if (++this.writesSinceTrim >= this.trimEvery) this.trim();
  }

  /**
   * Keeps the newest `cap` rows. `id` is AUTOINCREMENT and therefore monotonic, so the
   * cutoff is a single indexed lookup rather than a scan of the whole table.
   */
  trim(): void {
    this.writesSinceTrim = 0;
    try {
      const cutoff = this.db
        .prepare(`SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?`)
        .get(this.cap) as { id: number } | undefined;
      if (cutoff) this.db.prepare('DELETE FROM activity WHERE id <= ?').run(cutoff.id);
    } catch (err) {
      this.log.warn('activity trim failed', { error: String(err) });
    }
  }

  list(limit = 100, before?: number): ActivityEntry[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.at, a.device_id, a.kind, a.detail, d.name AS device_name
           FROM activity a
           LEFT JOIN devices d ON d.id = a.device_id
          WHERE (? IS NULL OR a.id < ?)
          ORDER BY a.id DESC
          LIMIT ?`,
      )
      .all(before ?? null, before ?? null, Math.min(Math.max(limit, 1), 500)) as Array<{
      id: number;
      at: number;
      device_id: string | null;
      kind: string;
      detail: string | null;
      device_name: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      deviceId: r.device_id,
      deviceName: r.device_name,
      kind: r.kind,
      detail: parseDetail(r.detail),
    }));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number }).n;
  }
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
