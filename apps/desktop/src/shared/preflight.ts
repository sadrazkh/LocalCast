/**
 * Prerequisites: what LocalCast needs that it cannot ship in the installer, how the app
 * detects each one, and what it offers to do about it.
 *
 * The rule this file exists to enforce: **a missing prerequisite is shown at the first
 * screen, in plain language, with the action attached.** Not a stack trace on a console
 * nobody is reading, not a window that opens onto a UI wired to nothing, and not a silent
 * degradation the user discovers when a print job never arrives.
 */

export type PrerequisiteId =
  /** The Go sidecar. Without it there is no access from outside the local network at all. */
  | 'netedge'
  /** SumatraPDF, which performs the actual printing. */
  | 'print-helper'
  /**
   * better-sqlite3 compiled against Electron's ABI rather than Node's. A developer running
   * from source hits this; a packaged build never does, because electron-builder rebuilds it.
   */
  | 'native-modules';

export type PrerequisiteSeverity =
  /** The app cannot function. Setup stops here. */
  | 'blocking'
  /** One feature is unavailable; everything else works. Setup may continue. */
  | 'degrading';

export type PrerequisiteState =
  | 'checking'
  | 'ok'
  /** Not present, and we know how to obtain it. */
  | 'missing'
  /** Present but unusable — wrong ABI, wrong architecture, corrupt. */
  | 'broken'
  /** Being fetched or built right now. */
  | 'installing';

/** What the app can offer to do about a missing prerequisite. */
export type RemedyKind =
  /** Fetch a published file, verify its digest, put it in place. */
  | 'download'
  /** Run a command we already have (an npm script, a local toolchain). */
  | 'command'
  /** Nothing safe to automate; open the instructions and let the user act. */
  | 'manual';

export interface Remedy {
  kind: RemedyKind;
  /** Button label key, resolved by the renderer's catalogue. */
  labelKey: string;
  /** For `download`: the publisher's page, shown next to the button so the source is visible. */
  sourceUrl?: string;
  /** For `manual`: the document that explains what to do. */
  docPath?: string;
  /** For `command`: shown to the user before it runs. Nothing is executed unseen. */
  command?: string;
}

export interface PrerequisiteStatus {
  id: PrerequisiteId;
  severity: PrerequisiteSeverity;
  state: PrerequisiteState;
  /** Where the app looked. Shown when the state is `missing`, so the fix is obvious. */
  searchedPaths: string[];
  /** The concrete reason, already localised. Empty when `ok`. */
  detail: string;
  /** What the app can do about it, in the order it should be offered. */
  remedies: Remedy[];
  /** 0–1 while `installing`. */
  progress?: number;
}

export interface PreflightReport {
  items: PrerequisiteStatus[];
  /** True when nothing blocking is outstanding. The wizard will not advance until it is. */
  canProceed: boolean;
  /** True when every prerequisite is satisfied, including the degrading ones. */
  allSatisfied: boolean;
  checkedAt: number;
}

/**
 * A file the app may fetch on the user's behalf.
 *
 * `sha256` is **not optional in spirit**: a download that is not checked against a digest the
 * maintainer recorded is a download that can be anything. It is typed as optional only
 * because a digest that was invented rather than measured is worse than none — it passes
 * every test and proves nothing. When it is absent the installer must refuse to install
 * silently: it reports the digest it computed and requires the user to confirm it against
 * the publisher's own checksum page, which `sourceUrl` points at.
 */
export interface DownloadSpec {
  id: PrerequisiteId;
  /** Direct URL to the artefact. Pinned to a version; never `latest`. */
  url: string;
  /** The publisher's download or checksum page, shown to the user before anything is fetched. */
  sourceUrl: string;
  version: string;
  /** Lowercase hex. Absent means "not yet recorded by a maintainer" — see above. */
  sha256?: string;
  /** Where the verified file lands, relative to the app's vendor directory. */
  destination: string;
  sizeBytes?: number;
  /** Licence the user is accepting by installing it. Shown in the confirmation. */
  licence: string;
}

export type InstallOutcome =
  | { ok: true; id: PrerequisiteId; installedTo: string }
  | {
      ok: false;
      id: PrerequisiteId;
      reason:
        | 'network'
        | 'digest-mismatch'
        | 'digest-unrecorded'
        | 'declined'
        | 'write-failed'
        | 'unsupported';
      /** For `digest-mismatch` and `digest-unrecorded`: what we actually computed. */
      computedSha256?: string;
      message: string;
    };

export const PREFLIGHT_IPC = {
  run: 'preflight:run',
  install: 'preflight:install',
  progress: 'preflight:progress',
  openDoc: 'preflight:open-doc',
  runCommand: 'preflight:run-command',
} as const;
