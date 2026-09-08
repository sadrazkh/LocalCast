import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, startServer, type TestServer } from './helpers.js';

/**
 * A busy port must cost the local network, and nothing else.
 *
 * The failure this replaces: `listen` awaited the LAN bind directly, so `EADDRINUSE` rejected out
 * of `listen`, out of the desktop's `startServer`, out of `bootstrap`, and into a fatal-error
 * dialog — `app.exit(1)`. One held port took down the entire application: no panel, no operator
 * API, no folders, no devices. And the most ordinary way to hold that port is to have a previous
 * copy of LocalCast still sitting in the system tray, which is precisely what happens when
 * somebody closes the window and opens it again.
 */

const started: TestServer[] = [];
const squatters: net.Server[] = [];

/** Holds a port the way another process would. */
function squat(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    squatters.push(server);
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
}

/** A port nothing else in the suite will ask for. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  await Promise.all(
    squatters.map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
  cleanupTempDirs();
});

describe('when the local-network port is taken', () => {
  it('moves to the next free port rather than failing', async () => {
    const wanted = await freePort();
    await squat(wanted);

    const ts = await startServer({ lan: true, lanPort: wanted });
    started.push(ts);

    // Bound somewhere, and somewhere near what was asked for. The QR code carries the port, so a
    // device is handed whichever one this turned out to be and pairing is unaffected.
    const bound = ts.server.lanAddress()?.port;
    expect(bound).toBeDefined();
    expect(bound).not.toBe(wanted);
    expect(bound).toBeGreaterThan(wanted);
    expect(ts.server.lanStatus().state).toBe('listening');
    expect(ts.server.lanEndpoint()?.url).toContain(`:${bound}`);
  });

  it('keeps the operator API answering when every nearby port is taken', async () => {
    const wanted = await freePort();
    // The whole search span, so there is nowhere left to go.
    for (let offset = 0; offset <= 8; offset += 1) {
      try {
        await squat(wanted + offset);
      } catch {
        // Something else already has it; that serves this test just as well.
      }
    }

    const ts = await startServer({ lan: true, lanPort: wanted });
    started.push(ts);

    // The app is up. This is the assertion the old code could not make: it never got here.
    const res = await ts.fetch('/operator/folders');
    expect(res.status).toBe(200);

    const status = ts.server.lanStatus();
    expect(status.state).toBe('failed');
    expect(status.url).toBeNull();
    // A sentence naming the likely cause, not an errno. The user's next action is to look in the
    // tray, and nothing in `EADDRINUSE` tells them that.
    expect(status.error).toMatch(/in use or reserved/i);
    expect(status.error).toMatch(/system tray/i);
  });

  it('reports the three ways local sharing can be unavailable as three different states', async () => {
    // Null URL used to be the only signal, and it meant all three at once: switched off, no
    // address on this machine, could not bind. They call for three different things from the user.
    const off = await startServer();
    started.push(off);
    expect(off.server.lanStatus()).toMatchObject({ state: 'off', url: null, error: null });

    const on = await startServer({ lan: true });
    started.push(on);
    const status = on.server.lanStatus();
    expect(['listening', 'no-address']).toContain(status.state);
    expect(status.error).toBeNull();
    expect(status.encrypted).toBe(true);
  });

  it('publishes the plaintext address, and says it is not encrypted, only when it is on', async () => {
    const ts = await startServer({ lan: true, lanPlaintext: true });
    started.push(ts);

    const status = ts.server.lanStatus();
    expect(status.encrypted).toBe(false);
    expect(status.url).toMatch(/^http:\/\//);
    // The encrypted listener is still there on its own port; turning the fallback on does not
    // close it, it only changes which address is advertised.
    expect(status.securePort).not.toBeNull();
    expect(status.plaintextPort).not.toBeNull();
    expect(status.securePort).not.toBe(status.plaintextPort);
  });
});
