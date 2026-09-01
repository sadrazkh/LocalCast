import { PRINTING_ENABLED, REMOTE_ACCESS_ENABLED } from '../../shared/features.js';
import type {
  PreflightReport,
  PrerequisiteId,
  PrerequisiteSeverity,
  PrerequisiteStatus,
} from '../../shared/preflight.js';
import type { PreflightContext } from './context.js';
import {
  detectNativeModules,
  detectNetEdge,
  detectPrintHelper,
  NETEDGE_SEVERITY,
} from './detect.js';

/**
 * Runs every detector and answers the one question startup depends on: may the app proceed?
 *
 * The result is cached because it is read from three places — bootstrap, the wizard's first
 * paint, and every re-render after a remedy — and `require`ing a native module and shelling
 * out to `go version` on each of those would be both slow and pointless. `invalidate()` is
 * what an install calls to make the next read tell the truth again.
 */

let cached: PreflightReport | null = null;
let inFlight: Promise<PreflightReport> | null = null;

export function invalidate(): void {
  cached = null;
}

/** The last report, without running anything. `null` before the first run. */
export function cachedReport(): PreflightReport | null {
  return cached;
}

/**
 * `canProceed` is the gate the wizard will not advance past, so it is defined narrowly: a
 * blocking prerequisite counts as satisfied only when it is actually `ok`. `checking` and
 * `installing` are outstanding, not "probably fine".
 */
export function summarise(items: PrerequisiteStatus[], checkedAt = Date.now()): PreflightReport {
  return {
    items,
    canProceed: items.every((item) => item.severity !== 'blocking' || item.state === 'ok'),
    allSatisfied: items.every((item) => item.state === 'ok'),
    checkedAt,
  };
}

/**
 * A detector that throws must not take startup down with it — that is the exact failure mode
 * this whole subsystem exists to remove. An unexpected error becomes a `broken` item carrying
 * its own message, which at least reaches a screen.
 */
async function guard(
  id: PrerequisiteId,
  severity: PrerequisiteSeverity,
  detect: () => PrerequisiteStatus | Promise<PrerequisiteStatus>,
): Promise<PrerequisiteStatus> {
  try {
    return await detect();
  } catch (err) {
    return {
      id,
      severity,
      state: 'broken',
      searchedPaths: [],
      detail: `LocalCast could not check ${id}: ${err instanceof Error ? err.message : String(err)}`,
      remedies: [],
    };
  }
}

async function detectAll(ctx: PreflightContext): Promise<PreflightReport> {
  // Concurrent: `go version` spawns a process and the native module load touches the disk,
  // and this sits directly in front of the first window the user sees.
  const items = await Promise.all([
    // Same treatment as the print helper below, and for the same reason: while remote access
    // is switched off the sidecar cannot stand between the user and anything, because there is
    // no feature it could hold up. The prerequisites screen is the first thing shown on a
    // first run, and a row about `netedge.exe` there — green, missing, or offering to install
    // Go — is a question about a feature that is not in the build.
    //
    // NETEDGE_SEVERITY, not a literal, on the branch that does run it. A detector that throws
    // would otherwise come back blocking and stop the app over a sidecar it does not need —
    // reintroducing, through the error path, exactly the behaviour making sign-in optional was
    // meant to remove.
    ...(REMOTE_ACCESS_ENABLED
      ? [guard('netedge', NETEDGE_SEVERITY, () => detectNetEdge(ctx))]
      : []),
    // Omitted entirely rather than reported `ok`, or reported with a softer word. A
    // prerequisites screen is a list of things standing between the user and a working app,
    // and while printing is switched off SumatraPDF is not one of them: there is no route that
    // could use it. A row for it — even a green one — is a question the user has to answer
    // before they understand it does not matter. `detectPrintHelper` is untouched and comes
    // straight back when the flag does; see `shared/features.ts`.
    ...(PRINTING_ENABLED ? [guard('print-helper', 'degrading', () => detectPrintHelper(ctx))] : []),
    guard('native-modules', 'blocking', () => detectNativeModules(ctx.nativeBinding)),
  ]);

  const report = summarise(items);
  cached = report;
  return report;
}

export async function runPreflight(
  ctx: PreflightContext,
  options: { force?: boolean } = {},
): Promise<PreflightReport> {
  if (options.force) cached = null;
  if (cached) return cached;

  // Two windows asking at once must not produce two `go version` processes.
  inFlight ??= detectAll(ctx).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
