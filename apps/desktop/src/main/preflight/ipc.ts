import { BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PRINTING_ENABLED } from '../../shared/features.js';
import {
  PREFLIGHT_IPC,
  type InstallOutcome,
  type PreflightReport,
  type PrerequisiteId,
  type PrerequisiteStatus,
} from '../../shared/preflight.js';
import { CommandNotAllowed, prerequisiteForCommand, runAllowedCommand } from './commands.js';
import type { PreflightContext } from './context.js';
import { confirmAndInstall, install } from './downloads.js';
import { invalidate, runPreflight } from './run.js';

/**
 * The prerequisites bridge.
 *
 * Every handler here is reachable from a window that is, by design, the first thing shown
 * when something is wrong — which is exactly when the app is least sure of its own state. So
 * each one validates its argument against a fixed set rather than trusting it: an id must be
 * one of three, a document must resolve inside the app, and a command must be a key in the
 * allowlist. Nothing that arrives from the renderer is ever executed or opened as given.
 */

const PREREQUISITE_IDS: readonly PrerequisiteId[] = ['netedge', 'print-helper', 'native-modules'];

export interface PreflightIpcHooks {
  /** Called with every fresh report, so bootstrap can resume once nothing blocking is left. */
  onReport?: (report: PreflightReport) => void;
}

function asPrerequisiteId(raw: unknown): PrerequisiteId {
  const id = PREREQUISITE_IDS.find((candidate) => candidate === raw);
  if (!id) throw new Error(`unknown prerequisite: ${String(raw)}`);
  return id;
}

/**
 * The confirmed digest, however the bridge chose to pass it.
 *
 * The preload may forward the renderer's `{ confirmedSha256 }` options object or unwrap it
 * into a bare string. Accepting both means the confirmation seam cannot silently degrade into
 * an unconfirmed install: an unrecognised shape is `null`, which is "not confirmed".
 */
function confirmedDigest(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  if (raw && typeof raw === 'object') {
    const value = (raw as { confirmedSha256?: unknown }).confirmedSha256;
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function severityOf(id: PrerequisiteId): 'blocking' | 'degrading' {
  return id === 'print-helper' ? 'degrading' : 'blocking';
}

/**
 * Resolves a `Remedy.docPath` to a real file.
 *
 * Remedy documents are repository-relative paths this process wrote itself, but they arrive
 * back over IPC, and `shell.openPath` will happily launch anything. Absolute paths are refused
 * outright and a resolved path that has climbed out of the app's own directories is discarded,
 * so this can never become a way to open an arbitrary file on the user's machine.
 */
function resolveDoc(ctx: PreflightContext, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('a document path is required');
  }
  const requested = raw.trim();
  if (isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) {
    throw new Error(`refusing to open an absolute path: ${requested}`);
  }

  for (const root of [ctx.repoRoot, ctx.appRoot]) {
    const target = resolve(root, requested);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    if (existsSync(target)) return target;
  }

  throw new Error(`refusing to open ${requested}: it is not a document inside the application`);
}

export function registerPreflightIpc(ctx: PreflightContext, hooks: PreflightIpcHooks = {}): void {
  // Broadcast rather than reply to one sender: the wizard and the panel can both be open, and
  // a progress bar that only moves in whichever window happened to start the download is a
  // worse lie than no progress bar at all.
  const broadcast = (status: PrerequisiteStatus): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(PREFLIGHT_IPC.progress, status);
    }
  };

  const report = async (force: boolean): Promise<PreflightReport> => {
    const next = await runPreflight(ctx, { force });
    hooks.onReport?.(next);
    return next;
  };

  ipcMain.handle(PREFLIGHT_IPC.run, (_e, force?: unknown) => report(force === true));

  /**
   * `install(id)` downloads and verifies. When the artefact has no recorded digest it comes
   * back `digest-unrecorded` with the digest that was computed and installs nothing; the
   * renderer shows that next to the publisher's page and calls `install(id, digest)` only
   * after the user has confirmed it. Two calls on one channel, because the channel list in
   * `shared/preflight.ts` is the contract and does not grow for this.
   */
  ipcMain.handle(PREFLIGHT_IPC.install, async (_e, rawId: unknown, rawConfirmed?: unknown) => {
    const id = asPrerequisiteId(rawId);

    // `print-helper` stays a known id — the switch is temporary and the id is still the right
    // name for the thing — but nothing downloads a 20 MB helper for a feature no route in this
    // build can reach. The window that offered the button was showing a report from before the
    // flag; this is the check that makes it harmless rather than a surprising download.
    if (id === 'print-helper' && !PRINTING_ENABLED) {
      const refused: InstallOutcome = {
        ok: false,
        id,
        reason: 'unsupported',
        message:
          'Printing is switched off in this build, so the print helper is not needed. ' +
          'It can be installed once printing is switched back on.',
      };
      return refused;
    }

    const confirmed = confirmedDigest(rawConfirmed);
    const outcome = confirmed
      ? await confirmAndInstall(id, confirmed, ctx, { onProgress: broadcast })
      : await install(id, ctx, { onProgress: broadcast });

    if (outcome.ok) {
      invalidate();
      await report(false);
    }
    return outcome;
  });

  ipcMain.handle(PREFLIGHT_IPC.openDoc, async (_e, rawPath: unknown) => {
    const target = resolveDoc(ctx, rawPath);
    const error = await shell.openPath(target);
    // `openPath` reports failure by returning a message rather than rejecting, which would
    // otherwise look like success to the renderer.
    if (error) throw new Error(`could not open ${target}: ${error}`);
  });

  /**
   * The command is looked up in the allowlist, and only the table's own executable and
   * arguments are ever run. Both call shapes are accepted — `(command)` and `(id, command)` —
   * because the argument that matters is identified by being a key in the table, not by its
   * position.
   */
  ipcMain.handle(PREFLIGHT_IPC.runCommand, async (_e, first: unknown, second?: unknown) => {
    const command = [first, second].find(
      (candidate) => typeof candidate === 'string' && prerequisiteForCommand(candidate) !== null,
    );
    if (typeof command !== 'string') {
      throw new CommandNotAllowed(String(second ?? first));
    }
    const id = prerequisiteForCommand(command)!;

    broadcast({
      id,
      severity: severityOf(id),
      state: 'installing',
      searchedPaths: [],
      detail: `Running ${command}…`,
      remedies: [],
    });

    const result = await runAllowedCommand(command, ctx.repoRoot);

    // Whatever it did, the cached report is now a guess. Re-running is what turns a successful
    // build into a green tick without the user having to restart the app.
    invalidate();
    const fresh = await report(false);
    const repaired = fresh.items.find((item) => item.id === id);

    // Reported as an `InstallOutcome` so the renderer has one shape to reason about for every
    // remedy. A command that exited 0 but left the prerequisite still broken is a failure
    // here, because the only thing the user cares about is whether it is fixed.
    if (result.ok && repaired?.state === 'ok') {
      const outcome: InstallOutcome & { code: number | null; output: string } = {
        ok: true,
        id,
        installedTo: repaired.searchedPaths[0] ?? '',
        code: result.code,
        output: result.output,
      };
      return outcome;
    }

    const failed: InstallOutcome & { code: number | null; output: string } = {
      ok: false,
      id,
      reason: 'unsupported',
      message: result.output
        ? `\`${command}\` did not fix ${id} (exit ${result.code ?? 'killed'}):\n${result.output}`
        : `\`${command}\` did not fix ${id} (exit ${result.code ?? 'killed'}).`,
      code: result.code,
      output: result.output,
    };
    return failed;
  });
}
