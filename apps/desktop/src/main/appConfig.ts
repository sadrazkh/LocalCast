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
   * On by default **for now**, and that is a deliberate, temporary trade the owner asked for
   * so the rest of the product can be tested at all. The encrypted listener is real and keeps
   * running; the problem is what a phone does when it meets a certificate no authority signed.
   * It shows an interstitial, and an interstitial is not the app — so a scanned link stops
   * there and pairing never happens. Every symptom of that looked like a different bug.
   *
   * The cost is stated on screen rather than buried here: on a shared Wi-Fi an unencrypted
   * origin is readable by everyone else on it. This flips back to false once the certificate
   * path has been tried on real phones and the trust step is something a person can complete.
   */
  shareOnLanUnencrypted: z.boolean().default(true),
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
