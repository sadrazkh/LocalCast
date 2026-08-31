import { createServer } from 'node:net';
import type { Server } from 'node:http';

/**
 * Boots the Node app server inside the Electron main process.
 *
 * It binds loopback on an ephemeral port and rejects anything that does not carry the shared
 * secret, so the only way in is through `netedge`. Nothing else on the machine — no other
 * app, no browser pointed at 127.0.0.1 — can reach the user's files by guessing the port.
 */

export interface ServerHandle {
  port: number;
  http: Server;
  ctx: unknown;
  dispose(): Promise<void>;
}

export interface ServerHostOptions {
  dataDir: string;
  tempDir: string;
  vendorDir: string;
  edgeSecret: string;
  signingKey: Buffer;
  /** Directory holding the built PWA, served as the client. */
  webRoot: string;
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Imported dynamically so that a desktop build can start, show its window and report the
 * problem when the server package is missing — rather than dying at module load with a stack
 * trace the user cannot act on.
 */
export async function startServer(options: ServerHostOptions): Promise<ServerHandle> {
  let mod: {
    createServer: (opts: ServerHostOptions & { port: number; host: string }) => Promise<{
      listen(): Promise<Server>;
      dispose(): Promise<void>;
      ctx: unknown;
    }>;
  };
  try {
    mod = (await import('@localcast/server')) as never;
  } catch (cause) {
    throw new ServerNotBuilt(cause);
  }

  const port = await freePort();
  const instance = await mod.createServer({ ...options, port, host: '127.0.0.1' });
  const http = await instance.listen();

  return {
    port,
    http,
    ctx: instance.ctx,
    dispose: () => instance.dispose(),
  };
}
