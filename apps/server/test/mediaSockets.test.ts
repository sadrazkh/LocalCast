import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, startServer, type TestServer } from './helpers.js';

/**
 * A media player's socket survives the player going quiet.
 *
 * Node closes an idle keep-alive connection after five seconds. A player reading a film fills
 * its buffer, goes quiet for ten or twenty seconds, then wants the next stretch — and by then the
 * socket was gone, so every buffer refill began with a new connection and, over TLS, a new
 * handshake. That was a hitch at each refill, on some files and not others, depending only on
 * how large a buffer the player chose for that bitrate. The listeners now keep an idle socket
 * for two minutes.
 *
 * Tested on the loopback listener with a raw socket, because the property is about the socket,
 * and `fetch` would open a new one for the second request without telling us.
 */

const started: TestServer[] = [];

afterAll(async () => {
  await Promise.all(started.map((s) => s.dispose()));
  cleanupTempDirs();
});

function sendAndRead(socket: net.Socket, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      // The health route answers a small JSON body with a Content-Length; one read is enough
      // once the blank line and the body have both arrived.
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /content-length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd));
      const wanted = match ? Number(match[1]) : 0;
      if (buffer.length >= headerEnd + 4 + wanted) {
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(request);
  });
}

describe('an idle media connection', () => {
  it('is still open after longer than Node’s default five-second keep-alive', async () => {
    const ts = await startServer();
    started.push(ts);
    const port = ts.server.address()!.port;

    const socket = net.connect({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    let closed = false;
    socket.once('close', () => {
      closed = true;
    });

    const request = `GET /api/v1/folders HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`;
    const first = await sendAndRead(socket, request);
    expect(first).toMatch(/^HTTP\/1\.1 401/);

    // Longer than the default the old listeners had, shorter than a test should take.
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    expect(closed, 'the server closed the idle socket').toBe(false);

    // And it still answers on the same socket, which is what a player's next read needs.
    const second = await sendAndRead(socket, request);
    expect(second).toMatch(/^HTTP\/1\.1 401/);
    socket.destroy();
  }, 15_000);
});
