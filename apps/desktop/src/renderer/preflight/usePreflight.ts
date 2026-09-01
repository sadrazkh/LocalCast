import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InstallOutcome,
  PreflightReport,
  PrerequisiteId,
  PrerequisiteStatus,
  Remedy,
} from '../../shared/preflight.js';
import { messageOf } from '../lib/useAsync.js';
import { applyProgress, canCheck, getPreflightApi } from './api.js';

/**
 * The state behind the prerequisites screen: one report, the live progress pushed while
 * something is being installed, and the outcome of the last attempt per prerequisite.
 *
 * The outcome is kept **separately from the report** on purpose. A failed install leaves the
 * item exactly as it was — still `missing` — so a screen that re-read the report after every
 * attempt would answer "what happened when you pressed the button?" with silence. The
 * `digest-unrecorded` panel in particular has to survive until the user decides.
 */

export type PreflightPhase =
  /** The first check is in flight; the screen shows nothing yet rather than flashing. */
  | 'checking'
  | 'ready'
  /** The main process has no prerequisites bridge. Nothing is claimed, nothing is blocked. */
  | 'unavailable'
  | 'error';

export interface InstallAttempt {
  outcome: InstallOutcome;
  /** The remedy that produced it — the digest panel needs its `sourceUrl` back. */
  remedy: Remedy | null;
}

export type Attempts = Partial<Record<PrerequisiteId, InstallAttempt>>;

export interface PreflightController {
  report: PreflightReport | null;
  phase: PreflightPhase;
  error: string | null;
  /** The prerequisite whose remedy is running, if any. One at a time, deliberately. */
  busyId: PrerequisiteId | null;
  attempts: Attempts;
  /** `force` is for a check the user asked for by hand; the mount check accepts a cache. */
  recheck(force?: boolean): Promise<void>;
  install(id: PrerequisiteId, remedy: Remedy): Promise<void>;
  /**
   * The confirm-and-install path. **Only the confirm control on a `digest-unrecorded` result
   * may call this**, and it is the only function in this directory that passes a digest the
   * app did not verify itself.
   */
  confirmUnrecorded(id: PrerequisiteId, remedy: Remedy | null, sha256: string): Promise<void>;
  runCommand(id: PrerequisiteId, remedy: Remedy): Promise<void>;
  openDoc(docPath: string): Promise<void>;
  /** Clears the last outcome for an item, e.g. when the user declines an unverified file. */
  forget(id: PrerequisiteId): void;
}

/** A local stand-in for an outcome the main process never got the chance to produce. */
function unsupported(id: PrerequisiteId, message: string): InstallOutcome {
  return { ok: false, id, reason: 'unsupported', message };
}

export function usePreflight(): PreflightController {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [phase, setPhase] = useState<PreflightPhase>('checking');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<PrerequisiteId | null>(null);
  const [attempts, setAttempts] = useState<Attempts>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const recheck = useCallback(async (force = false) => {
    const api = getPreflightApi();
    if (!canCheck(api) || typeof api.run !== 'function') {
      // The bridge is not there. That is not the same as "everything is fine", but it is also
      // not evidence that anything is missing, so the screen steps aside instead of trapping
      // the user behind a check that cannot run.
      if (alive.current) setPhase('unavailable');
      return;
    }
    try {
      const next = await api.run(force);
      if (!alive.current) return;
      setReport(next);
      setError(null);
      setPhase('ready');
    } catch (err) {
      if (!alive.current) return;
      setError(messageOf(err));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    const subscribe = getPreflightApi()?.onProgress;
    if (typeof subscribe !== 'function') return;
    return subscribe((payload) => {
      setReport((current) => applyProgress(current, payload));
    });
  }, []);

  /** One place where a remedy is run, its outcome recorded, and the report refreshed. */
  const perform = useCallback(
    async (id: PrerequisiteId, remedy: Remedy | null, run: () => Promise<InstallOutcome>) => {
      setBusyId(id);
      try {
        const outcome = await run();
        if (!alive.current) return;
        setAttempts((current) => ({ ...current, [id]: { outcome, remedy } }));
        // Always, success or not. The main process pushes an `installing` status while a
        // remedy runs and does not push a correction when one fails, so a row that skipped
        // this would keep a progress bar moving over a job that is already over. Refreshing
        // costs nothing on screen: the outcome above is held apart from the report, so the
        // explanation — the digest panel especially — survives the repaint.
        await recheck();
      } catch (err) {
        if (!alive.current) return;
        setAttempts((current) => ({
          ...current,
          [id]: { outcome: unsupported(id, messageOf(err)), remedy },
        }));
      } finally {
        if (alive.current) setBusyId(null);
      }
    },
    [recheck],
  );

  const install = useCallback(
    async (id: PrerequisiteId, remedy: Remedy) => {
      const api = getPreflightApi();
      const start = api?.install;
      if (typeof start !== 'function') {
        setAttempts((current) => ({
          ...current,
          [id]: { outcome: unsupported(id, 'preflight.install'), remedy },
        }));
        return;
      }
      await perform(id, remedy, () => start(id));
    },
    [perform],
  );

  const confirmUnrecorded = useCallback(
    async (id: PrerequisiteId, remedy: Remedy | null, sha256: string) => {
      const api = getPreflightApi();
      const start = api?.install;
      if (typeof start !== 'function') return;
      await perform(id, remedy, () => start(id, { confirmedSha256: sha256 }));
    },
    [perform],
  );

  const runCommand = useCallback(
    async (id: PrerequisiteId, remedy: Remedy) => {
      const api = getPreflightApi();
      const command = remedy.command ?? '';
      const start = api?.runCommand;
      if (typeof start !== 'function' || !command) {
        setAttempts((current) => ({
          ...current,
          [id]: { outcome: unsupported(id, 'preflight.runCommand'), remedy },
        }));
        return;
      }
      await perform(id, remedy, () => start(id, command));
    },
    [perform],
  );

  const openDoc = useCallback(async (docPath: string) => {
    const open = getPreflightApi()?.openDoc;
    if (typeof open !== 'function') return;
    await open(docPath);
  }, []);

  const forget = useCallback((id: PrerequisiteId) => {
    setAttempts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  return {
    report,
    phase,
    error,
    busyId,
    attempts,
    recheck,
    install,
    confirmUnrecorded,
    runCommand,
    openDoc,
    forget,
  };
}

/** Not yet satisfied, and not currently being worked on. */
export function isOutstanding(item: PrerequisiteStatus): boolean {
  return item.state === 'missing' || item.state === 'broken';
}

/** In flight — the screen must not advance past an answer that has not arrived. */
export function isSettling(item: PrerequisiteStatus): boolean {
  return item.state === 'checking' || item.state === 'installing';
}

/**
 * Blocking items first. The report's own order is the main process's business, but on screen
 * the thing that stops the user has to be the thing they read first.
 */
export function inSeverityOrder(items: PrerequisiteStatus[]): PrerequisiteStatus[] {
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function rank(item: PrerequisiteStatus): number {
  if (item.state === 'ok') return 2;
  return item.severity === 'blocking' ? 0 : 1;
}
