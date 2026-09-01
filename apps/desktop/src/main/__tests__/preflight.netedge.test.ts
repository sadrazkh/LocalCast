// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrerequisiteStatus } from '../../shared/preflight.js';
import type { PreflightContext } from '../preflight/context.js';
import { detectNetEdge } from '../preflight/detect.js';
import { summarise } from '../preflight/run.js';

/**
 * The sidecar is never a reason not to start.
 *
 * This is the check that stops the app being made useless without an account again. `netedge`
 * is what lets *another* network reach this machine; on the same Wi-Fi it is not involved at
 * all, so a machine that has never built it — no Go toolchain, no interest in remote access —
 * must still get a working library, a working QR code and a working phone.
 *
 * Two things hold that, and both are asserted here rather than described: the detector's own
 * severity, and the report `canProceed` that bootstrap gates on.
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-preflight-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function contextIn(root: string): PreflightContext {
  return {
    appRoot: root,
    resourcesPath: root,
    repoRoot: root,
    vendorDir: join(root, 'vendor'),
    nativeBinding: '',
  };
}

const NATIVE_OK: PrerequisiteStatus = {
  id: 'native-modules',
  severity: 'blocking',
  state: 'ok',
  searchedPaths: [],
  detail: '',
  remedies: [],
};

const PRINT_MISSING: PrerequisiteStatus = {
  id: 'print-helper',
  severity: 'degrading',
  state: 'missing',
  searchedPaths: [],
  detail: '',
  remedies: [],
};

describe('the netedge prerequisite', () => {
  it('is degrading when the sidecar has never been built', async () => {
    const status = await detectNetEdge(contextIn(freshDir()));

    expect(status.state).toBe('missing');
    // The single line this whole invariant rests on. `blocking` here means an app that
    // refuses to start on a machine with no Go compiler and no Tailscale account.
    expect(status.severity).toBe('degrading');
    // …and it still says where it looked, so the user can act rather than guess.
    expect(status.searchedPaths.length).toBeGreaterThan(0);
  });

  it('is degrading when the sidecar is present too', async () => {
    const root = freshDir();
    writeFileSync(join(root, 'netedge.exe'), 'not a real binary', 'utf8');

    const status = await detectNetEdge(contextIn(root));
    expect(status.state).toBe('ok');
    // Same severity on both branches. A detector that only downgrades on the happy path would
    // still block the machine that actually needs the downgrade.
    expect(status.severity).toBe('degrading');
  });
});

describe('a report whose only outstanding item is netedge', () => {
  it('lets the app start', async () => {
    const netedge = await detectNetEdge(contextIn(freshDir()));
    const report = summarise([netedge, NATIVE_OK], 1);

    expect(netedge.state).not.toBe('ok');
    // What bootstrap gates on. `false` here is the app sitting on a prerequisites screen for
    // a feature the user may never want.
    expect(report.canProceed).toBe(true);
    expect(report.allSatisfied).toBe(false);
  });

  it('lets the app start with the print helper missing as well', async () => {
    const netedge = await detectNetEdge(contextIn(freshDir()));
    const report = summarise([netedge, PRINT_MISSING, NATIVE_OK], 1);

    // The two optional subsystems together are still not a reason to stop: browsing,
    // streaming, WebDAV and uploads need neither.
    expect(report.canProceed).toBe(true);
  });

  it('still stops for a genuinely blocking prerequisite', async () => {
    const netedge = await detectNetEdge(contextIn(freshDir()));
    const report = summarise([netedge, { ...NATIVE_OK, state: 'broken' }], 1);

    // The control case. Without it the two assertions above would pass against a `summarise`
    // that had simply stopped blocking on anything.
    expect(report.canProceed).toBe(false);
  });
});
