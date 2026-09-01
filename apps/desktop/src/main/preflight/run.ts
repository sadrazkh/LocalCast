import type {
  PreflightReport,
  PrerequisiteId,
  PrerequisiteSeverity,
  PrerequisiteStatus,
} from '../../shared/preflight.js';
import type { PreflightContext } from './context.js';
import { detectNativeModules, detectNetEdge, detectPrintHelper } from './detect.js';

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
    guard('netedge', 'blocking', () => detectNetEdge(ctx)),
    guard('print-helper', 'degrading', () => detectPrintHelper(ctx)),
    guard('native-modules', 'blocking', () => detectNativeModules()),
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
