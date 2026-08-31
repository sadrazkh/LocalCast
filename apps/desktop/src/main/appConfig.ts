import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

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
  /** False until the three-step wizard has been completed once. */
  setupComplete: z.boolean().default(false),
  launchOnStartup: z.boolean().default(true),
  /** Start the server without showing a window, once setup is done. */
  startMinimised: z.boolean().default(true),
  /** Stable across restarts so paired devices keep resolving the same MagicDNS name. */
  hostname: z.string().min(1).default('localcast'),
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
