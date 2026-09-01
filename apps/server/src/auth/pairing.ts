import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ApiException,
  ErrorCode,
  type FolderPermission,
  type PairClaimRequest,
  type QrPayload,
} from '@localcast/contract';
import type { Database as Db } from 'better-sqlite3';
import type { ActivityLog, EventBus } from '../kernel.js';
import {
  generateDavPassword,
  hashPassword,
  hashPasswordSync,
  randomString,
  verifyPassword,
} from './passwords.js';
import type { DeviceRow, IssuedTokens, TokenService } from './tokens.js';

/**
 * No `O`/`0`/`I`/`1`. The code is read off a screen and typed on a phone keyboard; the four
 * characters those glyphs collide in are the ones people get wrong. 32 symbols also divides
 * 256 evenly, so the rejection sampler in `randomString` never has to reject.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
/** Five wrong secrets and the code is dead. The QR path never trips this; typing does. */
export const MAX_FAILED_ATTEMPTS = 5;

export interface PairingTokenRow {
  id: string;
  code: string;
  secret_hash: string;
  failed_attempts: number;
  locked_at: number | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_by_device: string | null;
  default_permissions: string;
}

export interface MintOptions {
  defaultPermissions: FolderPermission[];
  ttlSeconds: number;
}

export interface MintResult {
  id: string;
  code: string;
  qr: QrPayload;
  expiresAt: number;
}

export interface ClaimResult {
  deviceId: string;
  claimTicket: string;
  status: 'pending' | 'approved';
}

export type PairStatusResult =
  | { status: 'pending' }
  | { status: 'rejected' }
  | ({
      status: 'approved';
      davPassword: string;
      device: { id: string; name: string };
    } & IssuedTokens);

export interface PairingServiceDeps {
  db: Db;
  tokens: TokenService;
  activity: ActivityLog;
  events: EventBus;
  /** Signs claim tickets. Reusing the JWT key keeps the number of secrets at one. */
  ticketSecret: Uint8Array;
  /**
   * Read at mint time rather than captured at construction: the MagicDNS name is not known
   * until `netedge` has connected, and it changes again whenever the user switches between
   * the default coordination server and their own Headscale. A snapshot taken at boot would
   * put a stale or placeholder host into the QR code.
   */
  publicHost: () => string;
  ownerUserId: () => string;
}

export class PairingService {
  /**
   * The generated WebDAV password is shown exactly once, so only its hash reaches the
   * database. It has to survive from the operator's approval until the device's next poll,
   * which is seconds, so it lives here rather than becoming a second stored secret. A server
   * restart in that window costs the user one re-pair; storing it would cost them a
   * permanent plaintext credential on disk.
   */
  private readonly pendingDavPasswords = new Map<string, { password: string; at: number }>();
  private static readonly DAV_STASH_TTL_MS = 60 * 60 * 1000;

  constructor(private readonly deps: PairingServiceDeps) {}

  mint(opts: MintOptions): MintResult {
    const { db } = this.deps;
    const now = Date.now();

    // Codes are globally unique, so spent ones have to be cleared or the 32^4 space shrinks
    // with every pairing. A day's grace keeps a recently used code from being reissued to a
    // different device while an old QR is still on screen.
    db.prepare(
      `DELETE FROM pairing_tokens
        WHERE (consumed_at IS NOT NULL AND consumed_at < ?)
           OR (expires_at < ?)`,
    ).run(now - 24 * 60 * 60 * 1000, now - 24 * 60 * 60 * 1000);

    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + opts.ttlSeconds * 1000;
    const id = randomUUID();
    // A pairing code lives for minutes and is guarded by the rate limiter and the lockout;
    // scrypt over the 32-byte secret is what actually protects the QR path.
    const secretHash = hashPasswordSync(secret);

    const insert = db.prepare(
      `INSERT INTO pairing_tokens
         (id, code, secret_hash, created_at, expires_at, default_permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let code = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      code = randomString(CODE_ALPHABET, CODE_LENGTH);
      try {
        insert.run(id, code, secretHash, now, expiresAt, JSON.stringify(opts.defaultPermissions));
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 19) throw err;
      }
    }

    this.deps.activity.record('pairing.minted', null, { code, ttlSeconds: opts.ttlSeconds });

    return {
      id,
      code,
      qr: { v: 1, host: this.deps.publicHost(), code, secret },
      expiresAt,
    };
  }

  async claim(req: PairClaimRequest, peer: string): Promise<ClaimResult> {
    const { db } = this.deps;
    const now = Date.now();
    const code = req.code.toUpperCase();

    const token = db.prepare('SELECT * FROM pairing_tokens WHERE code = ?').get(code) as
      | PairingTokenRow
      | undefined;

    // Same error for an unknown code and a wrong secret: the difference is exactly what a
    // guesser wants to learn.
    if (!token) throw new ApiException(ErrorCode.PAIRING_INVALID, 'Pairing code is not valid');
    if (token.locked_at !== null) {
      throw new ApiException(ErrorCode.PAIRING_LOCKED, 'Pairing code is locked after too many attempts');
    }
    if (token.consumed_at !== null) {
      throw new ApiException(ErrorCode.PAIRING_CONSUMED, 'Pairing code has already been used');
    }
    if (token.expires_at <= now) {
      throw new ApiException(ErrorCode.PAIRING_EXPIRED, 'Pairing code has expired');
    }

    // The secret is optional by contract: typing the 4-char code is the documented fallback
    // and is guarded by the lockout and the rate limiter instead. A *wrong* secret is always
    // a failure, though — it means someone is guessing at the QR.
    if (req.secret !== undefined) {
      const ok = await verifyPassword(req.secret, token.secret_hash);
      if (!ok) {
        this.registerFailure(token.id, token.failed_attempts + 1);
        if (token.failed_attempts + 1 >= MAX_FAILED_ATTEMPTS) {
          throw new ApiException(
            ErrorCode.PAIRING_LOCKED,
            'Pairing code is locked after too many attempts',
          );
        }
        throw new ApiException(ErrorCode.PAIRING_INVALID, 'Pairing code is not valid');
      }
    }

    const deviceId = randomUUID();
    const userId = this.deps.ownerUserId();

    // Consuming the token and creating the device is one step: two claims racing on the same
    // code must not both end up with a pending device.
    const consume = db.transaction(() => {
      const res = db
        .prepare(
          `UPDATE pairing_tokens
              SET consumed_at = ?, consumed_by_device = NULL
            WHERE id = ? AND consumed_at IS NULL AND locked_at IS NULL AND expires_at > ?`,
        )
        .run(now, token.id, now);
      if (res.changes !== 1) {
        throw new ApiException(ErrorCode.PAIRING_CONSUMED, 'Pairing code has already been used');
      }
      db.prepare(
        `INSERT INTO devices (id, user_id, name, platform, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).run(deviceId, userId, req.deviceName, req.platform, now);
      db.prepare('UPDATE pairing_tokens SET consumed_by_device = ? WHERE id = ?').run(
        deviceId,
        token.id,
      );
    });
    consume();

    this.deps.activity.record('device.claimed', deviceId, { name: req.deviceName, peer });
    this.deps.events.publish({ type: 'device', deviceId, status: 'pending' });

    return { deviceId, claimTicket: this.claimTicket(deviceId), status: 'pending' };
  }

  private registerFailure(tokenId: string, attempts: number): void {
    const locked = attempts >= MAX_FAILED_ATTEMPTS ? Date.now() : null;
    this.deps.db
      .prepare('UPDATE pairing_tokens SET failed_attempts = ?, locked_at = ? WHERE id = ?')
      .run(attempts, locked, tokenId);
  }

  /**
   * A signed handle over the device id. It is not a credential for anything but this poll,
   * and it stops anyone who can reach the edge from walking device ids to harvest the
   * access token and the one-time WebDAV password of a device someone else just paired.
   */
  private claimTicket(deviceId: string): string {
    return createHmac('sha256', this.deps.ticketSecret)
      .update(`claim:${deviceId}`)
      .digest('base64url');
  }

  private verifyTicket(deviceId: string, ticket: string): boolean {
    const expected = Buffer.from(this.claimTicket(deviceId), 'utf8');
    const given = Buffer.from(ticket, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async status(deviceId: string, ticket: string): Promise<PairStatusResult> {
    if (!this.verifyTicket(deviceId, ticket)) {
      throw new ApiException(ErrorCode.NOT_FOUND, 'Not found');
    }
    const device = this.deps.tokens.getDevice(deviceId);
    if (!device) throw new ApiException(ErrorCode.NOT_FOUND, 'Not found');
    if (device.status === 'pending') return { status: 'pending' };
    if (device.status !== 'active') return { status: 'rejected' };

    const stash = this.takeDavPassword(deviceId);
    if (!stash) {
      // Approved, but the one-time password is gone (a restart, or a second poll). Nothing
      // honest can be returned, so the device pairs again rather than being handed a session
      // it cannot mount WebDAV with.
      throw new ApiException(
        ErrorCode.PAIRING_EXPIRED,
        'Approval could not be delivered; please pair again',
      );
    }

    const session = await this.deps.tokens.issueSession(device);
    this.deps.activity.record('device.paired', deviceId, { name: device.name });
    return {
      status: 'approved',
      ...session,
      davPassword: stash,
      device: { id: device.id, name: device.name },
    };
  }

  async approve(deviceId: string): Promise<{ davPassword: string }> {
    const { db } = this.deps;
    const device = this.deps.tokens.getDevice(deviceId);
    if (!device) throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
    if (device.status === 'revoked') {
      throw new ApiException(ErrorCode.DEVICE_REVOKED, 'Device access has been closed');
    }

    const davPassword = generateDavPassword();
    const davHash = await hashPassword(davPassword);
    const perms = this.defaultPermissionsFor(deviceId);

    const apply = db.transaction(() => {
      db.prepare("UPDATE devices SET status = 'active', dav_password_hash = ? WHERE id = ?").run(
        davHash,
        deviceId,
      );
      const upsert = db.prepare(
        `INSERT INTO folder_permissions (device_id, folder_id, mode) VALUES (?, ?, ?)
         ON CONFLICT (device_id, folder_id) DO UPDATE SET mode = excluded.mode`,
      );
      for (const p of perms) {
        // A folder deleted since the code was minted must not resurrect as a dangling grant.
        const exists = db.prepare('SELECT 1 FROM shared_folders WHERE id = ?').get(p.folderId);
        if (exists) upsert.run(deviceId, p.folderId, p.mode);
      }
    });
    apply();

    this.pendingDavPasswords.set(deviceId, { password: davPassword, at: Date.now() });
    this.deps.activity.record('device.approved', deviceId, { name: device.name });
    this.deps.events.publish({ type: 'device', deviceId, status: 'active' });
    return { davPassword };
  }

  reject(deviceId: string): void {
    const device = this.deps.tokens.getDevice(deviceId);
    if (!device) throw new ApiException(ErrorCode.NOT_FOUND, 'Device not found');
    this.deps.tokens.revoke(deviceId);
    this.pendingDavPasswords.delete(deviceId);
    this.deps.activity.record('device.rejected', deviceId, { name: device.name });
    this.deps.events.publish({ type: 'device', deviceId, status: 'revoked' });
  }

  /** The snapshot taken when the code was minted, so later default changes do not widen it. */
  private defaultPermissionsFor(deviceId: string): FolderPermission[] {
    const row = this.deps.db
      .prepare('SELECT default_permissions FROM pairing_tokens WHERE consumed_by_device = ?')
      .get(deviceId) as { default_permissions: string } | undefined;
    if (!row) return [];
    try {
      const parsed: unknown = JSON.parse(row.default_permissions);
      return Array.isArray(parsed) ? (parsed as FolderPermission[]) : [];
    } catch {
      return [];
    }
  }

  private takeDavPassword(deviceId: string): string | undefined {
    const entry = this.pendingDavPasswords.get(deviceId);
    if (!entry) return undefined;
    this.pendingDavPasswords.delete(deviceId);
    if (Date.now() - entry.at > PairingService.DAV_STASH_TTL_MS) return undefined;
    return entry.password;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}
