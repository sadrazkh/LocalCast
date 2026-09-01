import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addFolder,
  bearer,
  cleanupTempDirs,
  pairDevice,
  probeDescriptorNumber,
  startServer,
  tempDir,
  type PairedDevice,
  type TestServer,
} from './helpers.js';

/**
 * The defect the spec calls out by name: scrubbing a 4K file abandons dozens of in-flight
 * range requests a second, and every one of them leaves a read stream — and its file
 * descriptor — alive unless the response's `close` destroys it. A few minutes of seeking is
 * then enough to exhaust the process.
 *
 * `process.report.getReport().libuv` is no use here: file descriptors opened by `fs` are
 * threadpool work, not libuv handles, so they never appear in it. What does move is the
 * number the OS hands out for the next descriptor — libuv allocates the lowest free slot, so
 * that number IS the current count of open descriptors.
 */

const DENSE_SIZE = 48 * 1024 * 1024;
const ABORTED_REQUESTS = 500;
const CONCURRENCY = 50;

let ts: TestServer;
let device: PairedDevice;
let fileId: string;
let probeFile: string;

beforeAll(async () => {
  const media = tempDir('lc-leak-');
  const dense = path.join(media, 'dense.bin');
  const chunk = Buffer.alloc(1024 * 1024, 0xa5);
  const fd = fs.openSync(dense, 'w');
  try {
    for (let written = 0; written < DENSE_SIZE; written += chunk.length) {
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  probeFile = dense;

  ts = await startServer();
  const folderId = await addFolder(ts, { path: media, label: 'Dense' });
  device = await pairDevice(ts, [{ folderId, mode: 'full' }]);

  const entries = await ts.json<{ entries: Array<{ id: string; name: string }> }>(
    `/api/v1/folders/${folderId}/entries`,
    { headers: bearer(device.accessToken) },
  );
  fileId = entries.entries.find((e) => e.name === 'dense.bin')?.id as string;
  expect(fileId).toBeTruthy();
}, 120_000);

afterAll(async () => {
  await ts?.dispose();
  cleanupTempDirs();
});

async function abortMidBody(): Promise<void> {
  const controller = new AbortController();
  try {
    const res = await ts.fetch(`/api/v1/files/${fileId}/content`, {
      headers: { ...bearer(device.accessToken), range: `bytes=0-${DENSE_SIZE - 1}` },
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (reader) {
      // One chunk is enough to guarantee the server has an open descriptor and is mid-pipe.
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
    } else {
      controller.abort();
    }
  } catch {
    // An aborted fetch rejects; that is the whole point of the request.
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('descriptor discipline under abandoned range requests', () => {
  it(`keeps the open-descriptor count flat across ${ABORTED_REQUESTS} aborted streams`, async () => {
    // Warm up first: the first few requests allocate sockets and prepared statements that
    // would otherwise show up as a one-off rise and be mistaken for a leak.
    for (let i = 0; i < CONCURRENCY; i++) await abortMidBody();
    await settle(300);

    const before = probeDescriptorNumber(probeFile);

    for (let sent = 0; sent < ABORTED_REQUESTS; sent += CONCURRENCY) {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, ABORTED_REQUESTS - sent) }, abortMidBody),
      );
    }

    await settle(500);
    const after = probeDescriptorNumber(probeFile);

    // If every abandoned stream leaked, `after` would be roughly `before + 500`. A small
    // drift is normal — sockets in TIME_WAIT, the WAL handle — so the bar is a fraction of
    // the request count rather than exact equality.
    expect(
      after - before,
      `descriptor number rose from ${before} to ${after} after ${ABORTED_REQUESTS} aborted requests`,
    ).toBeLessThan(50);
  }, 180_000);

  it('leaves no libuv handles behind either', async () => {
    await settle(200);
    const report = process.report?.getReport() as unknown as {
      libuv: Array<{ type: string; is_active: boolean }>;
    };
    const activeFsHandles = report.libuv.filter(
      (h) => h.is_active && (h.type === 'fs_event' || h.type === 'fs_poll'),
    );
    expect(activeFsHandles).toHaveLength(0);
  });

  it('proves the measure moves when descriptors really are held', () => {
    // Without this the assertion above could pass simply because the probe does not work.
    const baseline = probeDescriptorNumber(probeFile);
    const held = Array.from({ length: 100 }, () => fs.openSync(probeFile, 'r'));
    try {
      const raised = probeDescriptorNumber(probeFile);
      expect(raised - baseline).toBeGreaterThanOrEqual(50);
    } finally {
      for (const fd of held) fs.closeSync(fd);
    }
    expect(probeDescriptorNumber(probeFile) - baseline).toBeLessThan(10);
  });
});
