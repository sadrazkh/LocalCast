import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { ApiException, ErrorCode } from '@localcast/contract';
import type { Database as Db } from 'better-sqlite3';
import type { DeviceIdentity } from '../kernel.js';
import { fastHash } from './passwords.js';

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  status: 'pending' | 'active' | 'revoked';
  token_version: number;
  dav_password_hash: string | null;
  refresh_hash: string | null;
  refresh_expires_at: number | null;
  last_seen_at: number | null;
  last_peer: string | null;
  created_at: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TokenServiceOptions {
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
}

const ALG = 'HS256';

export class TokenService {
  constructor(
    private readonly db: Db,
    private readonly secret: Uint8Array,
    private readonly opts: TokenServiceOptions,
  ) {}

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  /**
   * The token carries identity and nothing else. Permissions are read from SQLite on every
   * request, so closing a folder in the panel takes effect immediately rather than at expiry.
   */
  async issueAccessToken(device: Pick<DeviceRow, 'id' | 'token_version'>): Promise<{
    token: string;
    expiresAt: number;
  }> {
    const now = Date.now();
    const expiresAt = now + this.opts.accessTokenTtlMs;
    const token = await new SignJWT({ tv: device.token_version })
      .setProtectedHeader({ alg: ALG })
      .setSubject(device.id)
      .setJti(randomUUID())
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(this.secret);
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<DeviceIdentity> {
    let sub: string | undefined;
    let tv: unknown;
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: [ALG] });
      sub = payload.sub;
      tv = payload['tv'];
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new ApiException(ErrorCode.TOKEN_EXPIRED, 'Access token has expired');
      }
      throw new ApiException(ErrorCode.UNAUTHENTICATED, 'Invalid access token');
    }

    if (!sub || typeof tv !== 'number') {
      throw new ApiException(ErrorCode.UNAUTHENTICATED, 'Invalid access token');
    }

    // Reloaded on every request precisely so that a revocation is not a promise about the
    // future — it is already true by the time the next byte is served.
    const device = this.getDevice(sub);
    if (!device) throw new ApiException(ErrorCode.UNAUTHENTICATED, 'Unknown device');
    if (device.status === 'pending') {
      throw new ApiException(ErrorCode.DEVICE_PENDING, 'Device is awaiting approval');
    }
    if (device.status !== 'active') {
      throw new ApiException(ErrorCode.DEVICE_REVOKED, 'Device access has been closed');
    }
    if (device.token_version !== tv) {
      throw new ApiException(ErrorCode.TOKEN_REVOKED, 'Access token has been revoked');
    }

    return {
      id: device.id,
      userId: device.user_id,
      name: device.name,
      platform: device.platform,
      tokenVersion: device.token_version,
    };
  }

  /**
   * Opaque and rotating. The device id prefix is not a secret — it only saves a table scan;
   * the 32 random bytes after it are what authenticates, and only their hash is stored.
   */
  issueRefreshToken(deviceId: string): string {
    const raw = randomBytes(32).toString('base64url');
    const token = `${deviceId}.${raw}`;
    this.db
      .prepare('UPDATE devices SET refresh_hash = ?, refresh_expires_at = ? WHERE id = ?')
      .run(fastHash(raw), Date.now() + this.opts.refreshTokenTtlMs, deviceId);
    return token;
  }

  async issueSession(device: Pick<DeviceRow, 'id' | 'token_version'>): Promise<IssuedTokens> {
    const { token, expiresAt } = await this.issueAccessToken(device);
    return { accessToken: token, refreshToken: this.issueRefreshToken(device.id), expiresAt };
  }

  /**
   * Rotation, not renewal: the moment a new refresh token exists the old one is dead. A
   * stolen refresh token therefore either loses the race or announces itself by failing.
   */
  async redeemRefreshToken(presented: string): Promise<IssuedTokens> {
    const sep = presented.indexOf('.');
    const deviceId = sep === -1 ? '' : presented.slice(0, sep);
    const raw = sep === -1 ? '' : presented.slice(sep + 1);

    const invalid = new ApiException(ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    if (!deviceId || !raw) throw invalid;

    const device = this.getDevice(deviceId);
    if (!device || !device.refresh_hash) throw invalid;
    if (device.status === 'pending') {
      throw new ApiException(ErrorCode.DEVICE_PENDING, 'Device is awaiting approval');
    }
    if (device.status !== 'active') {
      throw new ApiException(ErrorCode.DEVICE_REVOKED, 'Device access has been closed');
    }

    const presentedHash = Buffer.from(fastHash(raw), 'hex');
    const storedHash = Buffer.from(device.refresh_hash, 'hex');
    if (presentedHash.length !== storedHash.length || !timingSafeEqual(presentedHash, storedHash)) {
      throw invalid;
    }
    if (device.refresh_expires_at !== null && device.refresh_expires_at < Date.now()) {
      throw new ApiException(ErrorCode.TOKEN_EXPIRED, 'Refresh token has expired');
    }

    return this.issueSession(device);
  }

  /** Instant revocation: every token already in the wild fails its `tv` check. */
  revoke(deviceId: string): void {
    this.db
      .prepare(
        `UPDATE devices
            SET status = 'revoked', token_version = token_version + 1,
                refresh_hash = NULL, refresh_expires_at = NULL
          WHERE id = ?`,
      )
      .run(deviceId);
  }

  /** Throttled so a scrubbing player does not turn every range request into a write. */
  touch(deviceId: string, peer: string, minIntervalMs = 60_000): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE devices SET last_seen_at = ?, last_peer = ?
          WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      )
      .run(now, peer, deviceId, now - minIntervalMs);
  }
}
