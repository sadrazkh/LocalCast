import type { AddressInfo } from 'node:net';

/**
 * Boots the Node app server inside the Electron main process.
 *
 * It binds loopback on an ephemeral port and rejects anything that does not carry the shared
 * secret, so the only way in is through `netedge`. Nothing else on the machine — no other
 * app, no browser pointed at 127.0.0.1 — can reach the user's files by guessing the port.
 *
 * When local sharing is on it opens a second listener, on the network and **over HTTPS**,
 * using a certificate the server generates for itself. Loopback stays plain HTTP because
 * `netedge` proxies to it from the same machine; the network listener never does.
 */

export interface ServerHostOptions {
  dataDir: string;
  tempDir: string;
  vendorDir: string;
  edgeSecret: string;
  /** HS256 key for device tokens. Held by Electron behind DPAPI, never written here. */
  jwtSecret: Buffer;
  /** Directory holding the built PWA. Empty in development, where Vite serves it. */
  webRoot: string;
  version: string;
  /**
   * A better_sqlite3.node built for Electron's ABI. Empty falls back to the copy in
   * node_modules, which npm builds for Node — the wrong shape for this runtime.
   */
  nativeBinding: string;
  /** Listen on the local network too, so a phone on the same Wi-Fi needs no sign-in. */
  lan: boolean;
  /**
   * Also serve the local network unencrypted, and publish *that* address.
   *
   * A temporary trade: a self-signed certificate stops a phone at an interstitial, and an
   * interstitial is not the app, so a scanned link never becomes a paired device.
   */
  lanPlaintext: boolean;
}

export interface ServerHandle {
  /** The loopback HTTP port. This is what `netedge` proxies to and the operator API uses. */
  port: number;
  /**
   * `https://192.168.1.50:8443` — where a device on the same Wi-Fi connects. Null when local
   * sharing is off, or when this machine has no address on a local network.
   */
  lanUrl: string | null;
  /**
   * SHA-256 of the certificate that origin presents, uppercase colon-separated hex. Shown in
   * the panel and carried in the QR code so a native client can pin it.
   */
  lanFingerprint: string | null;
  /**
   * Publishes the MagicDNS name once `netedge` knows it.
   *
   * The server cannot be told this at boot: the node has not connected yet, and the name
   * changes again whenever the user switches between the default coordination server and
   * their own Headscale. Pairing reads it at mint time, so a QR minted after this call
   * carries the right host without anything being restarted.
   */
  setPublicHost(host: string): void;
  dispose(): Promise<void>;
}

export class ServerNotBuilt extends Error {
  constructor(cause: unknown) {
    super(
      '@localcast/server has not been built yet. Run `npm run build --workspace=@localcast/server` ' +
        `first. (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'ServerNotBuilt';
  }
}

/** Shape of `@localcast/server`, kept local so the desktop build does not need its types. */
interface ServerModuleShape {
  createServer(options: Record<string, unknown>): Promise<{
    config: { publicHost: string };
    listen(port?: number): Promise<AddressInfo>;
    lanEndpoint(): { url: string; fingerprint256: string } | null;
    dispose(): Promise<void>;
  }>;
}

/**
 * Imported dynamically so a desktop build can start, show its window and report the problem
 * when the server package is missing — rather than dying at module load with a stack trace
 * the user cannot act on.
 */
export async function startServer(options: ServerHostOptions): Promise<ServerHandle> {
  let mod: ServerModuleShape;
  try {
    mod = (await import('@localcast/server')) as unknown as ServerModuleShape;
  } catch (cause) {
    throw new ServerNotBuilt(cause);
  }

  const instance = await mod.createServer({
    dataDir: options.dataDir,
    tempDir: options.tempDir,
    vendorDir: options.vendorDir,
    edgeSecret: options.edgeSecret,
    jwtSecret: new Uint8Array(options.jwtSecret),
    webRoot: options.webRoot,
    version: options.version,
    nativeBinding: options.nativeBinding,
    lan: options.lan,
    lanPlaintext: options.lanPlaintext,
    host: '127.0.0.1',
    // 0 asks the OS for a free port. Nothing outside this process needs to predict it —
    // netedge is told the number after the fact.
    port: 0,
  });

  const address = await instance.listen();
  // Read after `listen`, never before: the LAN listener's port is assigned by the OS, and the
  // URL is not knowable until it is bound.
  const lan = instance.lanEndpoint();

  return {
    port: address.port,
    lanUrl: lan?.url ?? null,
    lanFingerprint: lan?.fingerprint256 ?? null,
    setPublicHost(host: string) {
      instance.config.publicHost = host;
    },
    dispose: () => instance.dispose(),
  };
}
