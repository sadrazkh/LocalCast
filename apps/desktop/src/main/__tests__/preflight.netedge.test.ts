// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrerequisiteStatus } from '../../shared/preflight.js';
import type { PreflightContext } from '../preflight/context.js';
import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';
import { detectNetEdge } from '../preflight/detect.js';
import { runPreflight, summarise } from '../preflight/run.js';

/**
 * The sidecar is never a reason not to start.
 *
 * This is the check that stops the app being made useless without an account again. `netedge`
 * is what lets *another* network reach this machine; on the same Wi-Fi it is not involved at
 * all, so a machine that has never built it — no Go toolchain, no interest in remote access —
 * must still get a working library, a working QR code and a working phone.
 *
 * Three things hold that, and all three are asserted here rather than described:
 *
 *   - while remote access is switched off, the report does not mention the sidecar *at all*,
 *     so the first screen of a first run has nothing to say about a feature that is not in
 *     the build;
 *   - when it is switched back on, the detector's own severity is `degrading`;
 *   - and the report `canProceed` that bootstrap gates on stays true with it outstanding.
 *
 * The detector tests keep running with the feature off on purpose: `detectNetEdge` is live
 * code either way, and its severity is the invariant that made the app startable without an
 * account in the first place. Deciding it is unreachable today is how it comes back wrong.
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

describe('the prerequisites report while remote access is switched off', () => {
  it.skipIf(REMOTE_ACCESS_ENABLED)('does not mention the sidecar at all', async () => {
    // A directory with nothing in it. The detector, were it running, would report `netedge`
    // missing and offer to build it — nothing here mocks it away; the point is that it is
    // never asked.
    const report = await runPreflight(contextIn(freshDir()), { force: true });
    const ids = report.items.map((item) => item.id);

    expect(ids).not.toContain('netedge');
    // Not vacuous: the report is a real one, with the prerequisites that do apply in it.
    expect(ids).toContain('native-modules');
    // And nothing switched off can be a reason to stop.
    expect(report.canProceed).toBe(true);
  });
});

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
