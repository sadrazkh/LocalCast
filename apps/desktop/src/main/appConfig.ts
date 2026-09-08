import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { REMOTE_ACCESS_ENABLED } from '../shared/features.js';

/**
 * Non-secret application preferences, kept in `config.json` next to the database.
 *
 * Network settings live in SQLite's `network_config` and secrets live behind DPAPI; nothing
 * sensitive is ever written here. Keeping the split explicit means this file can be read,
 * copied or attached to a bug report without leaking anything.
 */

const appConfigSchema = z.object({
  version: z.literal(1),
  locale: z.enum(['fa', 'en']).default('fa'),
  /** False until the first-run wizard has been completed once. */
  setupComplete: z.boolean().default(false),
  launchOnStartup: z.boolean().default(true),
  /** Start the server without showing a window, once setup is done. */
  startMinimised: z.boolean().default(true),
  /** Stable across restarts so paired devices keep resolving the same MagicDNS name. */
  hostname: z.string().min(1).default('localcast'),
  /**
   * Share over the local network. On by default, and the reason signing in is optional: a
   * phone on the same Wi-Fi reaches the library with no account and no coordination server.
   */
  shareOnLan: z.boolean().default(true),
  /**
   * Serve the local network without TLS.
   *
   * **Off.** It was briefly on by default, as a way to get past a certificate interstitial while
   * the rest of pairing was being made to work, and that trade has been paid back: the reason a
   * scanned link never became a paired device was a client-side check that refused every bare IP
   * address, not the certificate. With that fixed there is nothing left for plaintext to buy, and
   * on a shared Wi-Fi an unencrypted origin hands every bearer token and every byte of every file
   * to whoever else is on the network.
   *
   * It stays as a switch rather than being deleted, because some devices genuinely cannot get
   * past a self-signed certificate at all — an embedded webview with no "proceed" affordance, a
   * device under a managed configuration profile. For those the choice is plaintext or nothing,
   * and it is the operator's to make, from the panel, with the cost on screen. Flipping it takes
   * effect immediately; nothing restarts.
   */
  shareOnLanUnencrypted: z.boolean().default(false),
  /**
   * Force the address published to devices, instead of detecting it.
   *
   * Empty, which is the normal case: the server picks the machine's real network adapter and
   * ignores VPN tunnels and virtual switches — see `net/lanAddress.ts` for how. This exists for
   * the machine where that still lands on the wrong one of several real adapters, because the
   * alternative for such a user is waiting for a new build. It is a plain string in a file they
   * can open in Notepad, and an address typed here goes into the certificate too, so nothing
   * else has to be reconfigured to match.
   */
  lanAddress: z.string().default(''),
  /**
   * Reach this machine from other networks. Off until the user asks for it — it is the only
   * part of the product that needs an account, and most people never leave the house with it.
   *
   * This is the user's answer and nothing else. While `REMOTE_ACCESS_ENABLED` is false the
   * build overrides it — see `remoteAccessOn` — but the stored value is left exactly as the
   * user set it, so switching the feature back on restores what they had rather than quietly
   * resetting everyone to off.
   */
  remoteAccess: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

const DEFAULTS: AppConfig = appConfigSchema.parse({ version: 1 });

export class AppConfigStore {
  #cache: AppConfig;

  constructor(private readonly path: string) {
    this.#cache = this.#read();
  }

  #read(): AppConfig {
    try {
      const parsed = appConfigSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      // A config file that has been hand-edited into an invalid state should not stop the
      // app from starting — the user's files still need serving. Fall back to defaults and
      // let the next write repair it.
      return parsed.success ? parsed.data : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get(): AppConfig {
    return this.#cache;
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.#cache = appConfigSchema.parse({ ...this.#cache, ...patch });
    this.#write();
    return this.#cache;
  }

  /** Write to a sibling then rename, so a crash mid-write cannot truncate the config. */
  #write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#cache, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }
}

export function configPathFor(dataDir: string): string {
  return join(dataDir, 'config.json');
}

/**
 * Should remote access actually run?
 *
 * Two gates, and the order is the point: the build switch can only ever turn the feature
 * *off*, never on. A preference the user has stored survives untouched underneath it, which is
 * what makes this a switch rather than a migration — flip `REMOTE_ACCESS_ENABLED` back to true
 * and someone who had it enabled gets it back on the next start with nothing to re-configure.
 *
 * One function rather than `FLAG && config.remoteAccess` written at each call site, so
 * re-enabling cannot leave one of them behind.
 */
export function remoteAccessOn(config: AppConfig): boolean {
  return REMOTE_ACCESS_ENABLED && config.remoteAccess;
}
