/**
 * Runs the parts of docs/acceptance-checklist.md that do not need a second device.
 *
 * The checklist exists because unit tests cannot settle certain claims. But several of those
 * claims need only *a network hop and a real server* — not an iPhone — and leaving them in a
 * manual document meant nobody ever checked them. This drives the real HTTP(S) surface over
 * this machine's own LAN address, which is the same path a phone takes.
 *
 * What it cannot cover stays in the checklist and is listed at the end of every run, so the
 * gap is visible rather than forgotten:
 *   B1  printing from a different network
 *   C1  switching to a personal Headscale and back
 *   C2  the Headscale deployment itself
 *   D1  the iOS Files app and Infuse against the WebDAV mount
 *   E1  home-screen install and the camera permission
 *
 *   node scripts/acceptance.mjs
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The LAN certificate is self-signed by design: a home network has no certificate authority.
// Verification is off *in this harness only*, which talks to a server it started itself
// moments earlier on an address it computed itself. Nothing else in the project does this,
// and the desktop client pins the fingerprint rather than turning verification off.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** Whichever scheme the server actually answers on, rather than an assumption about it. */
async function detectScheme(host, port) {
  for (const scheme of ['https', 'http']) {
    try {
      await fetch(`${scheme}://${host}:${port}/api/v1/folders`);
      return scheme;
    } catch {
      // Wrong scheme fails at the TLS layer; try the other one.
    }
  }
  throw new Error(`the server on ${host}:${port} answered neither https nor http`);
}

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${id}  ${title}${detail ? `\n        ${detail}` : ''}`);
}

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

/**
 * A deterministic file big enough to catch a 32-bit offset mistake.
 *
 * Sparse: the bytes that matter are written at known offsets and the rest is a hole, so this
 * costs no disk and a second or two rather than the twenty minutes a real 5 GiB write takes.
 */
const BIG = 5 * 1024 * 1024 * 1024;
const BLOCK = 64 * 1024;
const MARKS = [0, 1 << 30, 0xffff_0000, 0x1_0000_0000, 0x1_2000_0000, BIG - BLOCK];

function patternFor(offset) {
  const buf = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i += 1) buf[i] = (offset + i * 31 + 7) % 256;
  return buf;
}

function makeSparseFixture(dir) {
  const file = join(dir, 'Big.Sample.2160p.mp4');
  const fd = openSync(file, 'w');
  try {
    // fsutil marks it sparse so the hole costs nothing; without it this writes 5 GiB.
    spawn('fsutil', ['sparse', 'setflag', file], { stdio: 'ignore' });
    for (const offset of MARKS) writeSync(fd, patternFor(offset), 0, BLOCK, offset);
  } finally {
    closeSync(fd);
  }
  return file;
}

/** A tiny MKV. Only the extension and the first bytes matter: it must not be browser-playable. */
function makeMkv(dir) {
  const file = join(dir, 'Not.Playable.mkv');
  const fd = openSync(file, 'w');
  writeSync(fd, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]), 0, 8, 0);
  closeSync(fd);
  return file;
}

async function main() {
  const lan = lanAddress();
  if (!lan) {
    console.error('No LAN address on this machine; nothing here can be checked.');
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'localcast-acceptance-'));
  const share = join(work, 'share');
  mkdirSync(share, { recursive: true });

  console.log(`LocalCast acceptance — over ${lan}\n`);
  console.log('Preparing a 5 GiB sparse fixture and an MKV…');
  const big = makeSparseFixture(share);
  makeMkv(share);

  // pathToFileURL, not the bare path: an absolute Windows path looks like a URL with an `e:`
  // scheme to the ESM loader, which refuses it.
  const { createServer } = await import(pathToFileURL(join(ROOT, 'apps/server/dist/index.js')).href);
  const server = await createServer({
    dataDir: join(work, 'data'),
    edgeSecret: randomBytes(32).toString('hex'),
    jwtSecret: randomBytes(32),
    lan: true,
    indexOnStart: false,
    logLevel: 'silent',
    publicHost: lan,
  });
  const addr = await server.listen(0);
  const scheme = await detectScheme(lan, addr.port);
  const base = `${scheme}://${lan}:${addr.port}`;
  console.log(`Server on ${base}${scheme === 'http' ? '  (NOT ENCRYPTED)' : ''}\n`);

  try {
    await runChecks({ server, base, share, big, work });
  } finally {
    await server.dispose();
    rmSync(work, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(
    '\nStill only provable on real hardware, and untouched by this run:\n' +
      '  B1  print from a different network\n' +
      '  C1  switch to a personal Headscale and back\n' +
      '  C2  the Headscale deployment on a VPS\n' +
      '  D1  the iOS Files app and Infuse against WebDAV\n' +
      '  E1  home-screen install and camera permission',
  );
  process.exit(failed.length ? 1 : 0);
}

async function runChecks(ctx) {
  const { server, base, share, big } = ctx;
  const op = (path, init) =>
    fetch(`http://127.0.0.1:${server.address().port}/operator${path}`, {
      ...init,
      // The operator API is loopback-only; that is exactly why this uses http and 127.0.0.1.
      headers: {
        'content-type': 'application/json',
        'x-lc-edge-secret': server.config.edgeSecret,
        ...(init?.headers ?? {}),
      },
    });

  const folder = await (
    await op('/folders', {
      method: 'POST',
      body: JSON.stringify({ path: share, label: 'Acceptance', kind: 'video', writable: false }),
    })
  ).json();
  const folderId = folder.folder?.id ?? folder.id;
  await op(`/folders/${folderId}/reindex`, { method: 'POST' });
  await server.indexer.indexAll();

  const minted = await (
    await op('/pairing', {
      method: 'POST',
      body: JSON.stringify({ defaultPermissions: [{ folderId, mode: 'full' }] }),
    })
  ).json();

  const claim = await (
    await fetch(`${base}/api/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: minted.code,
        secret: minted.qr.secret,
        deviceName: 'Acceptance harness',
        platform: 'web',
      }),
    })
  ).json();

  const devices = await (await op('/devices')).json();
  const device = (devices.devices ?? devices).find((d) => d.name === 'Acceptance harness');
  await op(`/devices/${device.id}/approve`, { method: 'POST' });

  const approved = await (
    await fetch(`${base}/api/v1/pair/status/${claim.deviceId}?ticket=${encodeURIComponent(claim.claimTicket)}`)
  ).json();
  const token = approved.accessToken;
  const auth = { authorization: `Bearer ${token}` };

  record('P0', 'Pair over the network and receive a device token', !!token);

  const entries = await (
    await fetch(`${base}/api/v1/folders/${folderId}/entries`, { headers: auth })
  ).json();
  const bigEntry = entries.entries.find((e) => e.name.endsWith('.mp4'));
  const mkvEntry = entries.entries.find((e) => e.name.endsWith('.mkv'));

  // ── A1: byte-exact seeking in a multi-gigabyte file, over the network ───────
  let a1 = !!bigEntry && bigEntry.size === BIG;
  let a1detail = bigEntry ? `size ${bigEntry.size}` : 'file not indexed';
  if (a1) {
    for (const offset of MARKS) {
      const res = await fetch(`${base}/api/v1/files/${bigEntry.id}/content`, {
        headers: { ...auth, range: `bytes=${offset}-${offset + BLOCK - 1}` },
      });
      const body = Buffer.from(await res.arrayBuffer());
      const want = patternFor(offset);
      if (res.status !== 206 || !body.equals(want)) {
        a1 = false;
        a1detail = `offset ${offset}: status ${res.status}, ${body.equals(want) ? 'bytes ok' : 'bytes differ'}`;
        break;
      }
    }
    if (a1) a1detail = `${MARKS.length} ranges byte-exact, including across 4 GiB`;
  }
  record('A1', 'Seek inside a multi-gigabyte file over the network', a1, a1detail);

  // ── A2: an MKV must not claim to be playable in a browser ──────────────────
  record(
    'A2',
    'MKV is reported unplayable so the client offers the native handoff',
    mkvEntry?.browserPlayable === false,
    mkvEntry ? `browserPlayable=${mkvEntry.browserPlayable}` : 'mkv not indexed',
  );

  // ── F1: closing access takes effect on the next request, mid-stream ────────
  const before = await fetch(`${base}/api/v1/files/${bigEntry.id}/content`, {
    headers: { ...auth, range: 'bytes=0-1023' },
  });
  await op(`/devices/${device.id}/revoke`, { method: 'POST' });
  const after = await fetch(`${base}/api/v1/files/${bigEntry.id}/content`, {
    headers: { ...auth, range: 'bytes=1024-2047' },
  });
  // 403 device_revoked, not 401. The token is still valid and unexpired — it is the device
  // that was closed, and the contract distinguishes the two so a client knows whether
  // refreshing would help. Asserting the code rather than only the status is what makes this
  // check meaningful: any refusal would satisfy "no longer served".
  const afterBody = await after.json().catch(() => ({}));
  record(
    'F1',
    'A revoked device loses access on its very next request',
    before.status === 206 && after.status === 403 && afterBody?.error?.code === 'device_revoked',
    `before ${before.status}, after ${after.status} ${afterBody?.error?.code ?? ''}`,
  );

  // ── G1: a folder whose drive is gone is reported, not silently empty ───────
  rmSync(share, { recursive: true, force: true });
  await server.indexer.indexAll();
  const folders = await (await op('/folders')).json();
  const gone = (folders.folders ?? folders).find((f) => f.id === folderId);
  record(
    'G1',
    'A folder whose drive is gone is marked unavailable rather than emptied',
    gone !== undefined && gone.available === false,
    gone ? `available=${gone.available}` : 'folder disappeared entirely',
  );
}

await main();
