import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isPairableHost } from '@localcast/client-core';

/**
 * The list of LocalCast servers this machine knows about — screen 05's data.
 *
 * Non-secret by construction: a host name, a label and two timestamps. The credentials that
 * go with each entry live in `SessionVault` behind DPAPI, so this file can be read, copied or
 * attached to a bug report without leaking anything.
 */

export interface ServerRecord {
  id: string;
  label: string;
  host: string;
  addedAt: number;
  lastConnectedAt: number | null;
}

interface RegistryFile {
  version: 1;
  servers: ServerRecord[];
}

export class InvalidServerHost extends Error {
  constructor(readonly host: string) {
    super(
      `«${host}» is not an address LocalCast can reach. A server is named by its MagicDNS ` +
        'host, e.g. ali-pc.tail1234.ts.net. A bare IP cannot hold a public certificate, so ' +
        'connecting to one would fail at TLS with nothing the user could do about it.',
    );
    this.name = 'InvalidServerHost';
  }
}

/**
 * A stable id derived from the host.
 *
 * Derived rather than random so the id survives the registry file being deleted and rebuilt:
 * the session vault is keyed by it, and a fresh random id would orphan a perfectly good
 * device token and force the user to pair again for no reason.
 */
export function serverIdFor(host: string): string {
  return host.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '-');
}

/** «ali-pc.tail1234.ts.net» → «ali-pc», which is what the user actually calls the machine. */
export function defaultLabelFor(host: string): string {
  const first = host.split('.')[0];
  return first !== undefined && first.length > 0 ? first : host;
}

export function baseUrlFor(host: string): string {
  // Always https and always the default port. The server terminates TLS at `netedge` on 443;
  // there is no configuration in which a client would need to name a port, and offering the
  // field would invite someone to type one that cannot work.
  return `https://${host}`;
}

export class ServerRegistry {
  readonly #path: string;
  #servers: ServerRecord[];

  constructor(path: string) {
    this.#path = path;
    this.#servers = this.#read();
  }

  list(): ServerRecord[] {
    return this.#servers.map((server) => ({ ...server }));
  }

  get(id: string): ServerRecord | null {
    return this.#servers.find((server) => server.id === id) ?? null;
  }

  /**
   * Add a server by host, or return the existing record when it is already known.
   *
   * The host is validated with `client-core`'s own `isPairableHost`, not a second regular
   * expression written here: the rule about bare IPs and MagicDNS names belongs to the shared
   * package, and having two copies of it is how they start to disagree.
   */
  add(host: string, label?: string): ServerRecord {
    const normalised = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!isPairableHost(normalised)) throw new InvalidServerHost(host);

    const id = serverIdFor(normalised);
    const existing = this.get(id);
    if (existing !== null) {
      if (label !== undefined && label.trim().length > 0) {
        existing.label = label.trim();
        this.#servers = this.#servers.map((s) => (s.id === id ? existing : s));
        this.#write();
      }
      return { ...existing };
    }

    const record: ServerRecord = {
      id,
      label: label?.trim() || defaultLabelFor(normalised),
      host: normalised,
      addedAt: Date.now(),
      lastConnectedAt: null,
    };
    this.#servers = [...this.#servers, record];
    this.#write();
    return { ...record };
  }

  remove(id: string): void {
    const next = this.#servers.filter((server) => server.id !== id);
    if (next.length === this.#servers.length) return;
    this.#servers = next;
    this.#write();
  }

  noteConnected(id: string, at: number): void {
    const server = this.#servers.find((s) => s.id === id);
    if (server === undefined) return;
    server.lastConnectedAt = at;
    this.#write();
  }

  #read(): ServerRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<RegistryFile>;
      if (!Array.isArray(parsed.servers)) return [];
      return parsed.servers.filter(
        (server): server is ServerRecord =>
          typeof server === 'object' &&
          server !== null &&
          typeof (server as ServerRecord).id === 'string' &&
          typeof (server as ServerRecord).host === 'string',
      );
    } catch {
      return [];
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const file: RegistryFile = { version: 1, servers: this.#servers };
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.#path);
  }
}
