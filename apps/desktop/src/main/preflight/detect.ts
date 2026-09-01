import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PrerequisiteStatus, Remedy } from '../../shared/preflight.js';
import { NetEdge, NetEdgeBinaryMissing } from '../netedge.js';
import {
  ELECTRON_REBUILD_COMMAND,
  NETEDGE_BUILD_COMMAND,
  NPM_INSTALL_COMMAND,
} from './commands.js';
import type { PreflightContext } from './context.js';
import { DOWNLOAD_SPECS } from './downloads.js';

/**
 * One detector per prerequisite.
 *
 * Each reports the real paths it searched, because "not found" without a list of places is a
 * message the user cannot act on — and because in this app the answer differs between a
 * checkout and a packaged install.
 *
 * `detail` is written in English. The remedy *buttons* are localised through `Remedy.labelKey`
 * and the renderer's catalogue; these sentences carry file paths, ABI numbers and toolchain
 * versions, which is diagnostic text the user is expected to be able to paste into a bug
 * report verbatim.
 */

const execFileAsync = promisify(execFile);

// ─── netedge ──────────────────────────────────────────────────────────────────

/** `go version go1.23.4 windows/amd64` */
const GO_VERSION = /^go version go(\d+)\.(\d+)(?:\.(\d+))?/;

/** `native/netedge/README.md` and `NetEdgeBinaryMissing` both say 1.23+. */
const MIN_GO_MINOR = 23;

export interface GoToolchain {
  /** As reported, e.g. `1.23.4`. */
  version: string;
  /** False when it is present but too old to build the sidecar. */
  usable: boolean;
}

/**
 * Looks for a Go toolchain on PATH.
 *
 * The build remedy is offered only when this succeeds. Offering "build it" on a machine with
 * no compiler produces a button that can only ever fail, which is worse than not offering it:
 * the user concludes the app is broken rather than that a tool is missing.
 */
export async function detectGoToolchain(
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = (file, args) =>
    execFileAsync(file, args, { timeout: 5_000, windowsHide: true }),
): Promise<GoToolchain | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('go', ['version']));
  } catch {
    return null;
  }

  // Parsed rather than merely "did it exit 0": something else called `go` on PATH would
  // otherwise be taken for the compiler.
  const match = GO_VERSION.exec(stdout.trim());
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const version = [match[1], match[2], match[3]].filter(Boolean).join('.');
  return { version, usable: major > 1 || (major === 1 && minor >= MIN_GO_MINOR) };
}

export async function detectNetEdge(ctx: PreflightContext): Promise<PrerequisiteStatus> {
  let binary: string;
  try {
    // Delegated rather than reimplemented: if the candidate list ever changes, the screen
    // that tells the user where LocalCast looked changes with it.
    binary = NetEdge.resolveBinary(ctx.appRoot, ctx.resourcesPath);
  } catch (err) {
    if (!(err instanceof NetEdgeBinaryMissing)) throw err;
    return netEdgeMissing(err.searched, await detectGoToolchain());
  }

  return {
    id: 'netedge',
    severity: 'blocking',
    state: 'ok',
    searchedPaths: [binary],
    detail: '',
    remedies: [],
  };
}

function netEdgeMissing(searched: string[], go: GoToolchain | null): PrerequisiteStatus {
  const remedies: Remedy[] = [];

  // There is no prebuilt netedge to fetch, and there must not be one invented here. The
  // lookup stays so that configuring a published build later needs no change to this file.
  const spec = DOWNLOAD_SPECS.netedge;
  if (spec) {
    remedies.push({
      kind: 'download',
      labelKey: 'preflight.remedy.download',
      sourceUrl: spec.sourceUrl,
    });
  }

  if (go?.usable) {
    remedies.push({
      kind: 'command',
      labelKey: 'preflight.remedy.build',
      command: NETEDGE_BUILD_COMMAND,
    });
  }

  remedies.push({
    kind: 'manual',
    labelKey: 'preflight.remedy.readDoc',
    docPath: 'native/netedge/README.md',
  });

  const detail = go?.usable
    ? `The network sidecar (netedge.exe) has not been built. Go ${go.version} is installed, so LocalCast can build it here.`
    : go
      ? `The network sidecar (netedge.exe) has not been built. Go ${go.version} is installed, but building it needs Go 1.${MIN_GO_MINOR} or newer.`
      : 'The network sidecar (netedge.exe) has not been built, and Go is not on PATH, so it cannot be built on this machine. Follow native/netedge/README.md.';

  return {
    id: 'netedge',
    severity: 'blocking',
    state: 'missing',
    searchedPaths: searched,
    detail,
    remedies,
  };
}

// ─── print helper ─────────────────────────────────────────────────────────────

/**
 * The names the print spooler accepts, in its order.
 *
 * Mirrored from `apps/server/src/modules/print/spooler.ts` rather than imported, because the
 * server package does not re-export them. Checking only the canonical name would have
 * preflight offer a download for a helper printing already works with.
 */
const PRINT_HELPER_NAMES = ['SumatraPDF.exe', 'SumatraPDF-portable.exe', 'sumatrapdf.exe'];

/**
 * SumatraPDF. Degrading on purpose: without it printing fails with a message that says so,
 * and browsing, streaming, WebDAV and uploads are all untouched. Setup must never stop here.
 */
export function detectPrintHelper(ctx: PreflightContext): PrerequisiteStatus {
  const candidates = PRINT_HELPER_NAMES.map((name) => join(ctx.vendorDir, name));
  const found = candidates.find((candidate) => existsSync(candidate));

  if (found) {
    return {
      id: 'print-helper',
      severity: 'degrading',
      state: 'ok',
      searchedPaths: [found],
      detail: '',
      remedies: [],
    };
  }

  const spec = DOWNLOAD_SPECS['print-helper'];
  const remedies: Remedy[] = [];
  if (spec) {
    remedies.push({
      kind: 'download',
      labelKey: 'preflight.remedy.download',
      sourceUrl: spec.sourceUrl,
    });
  }
  remedies.push({
    kind: 'manual',
    labelKey: 'preflight.remedy.readDoc',
    docPath: 'vendor/README.md',
  });

  return {
    id: 'print-helper',
    severity: 'degrading',
    state: 'missing',
    searchedPaths: candidates,
    detail:
      'The print helper (SumatraPDF) is not installed, so printing from a phone will fail. ' +
      'Everything else — browsing, playing video, WebDAV and uploads — works without it.',
    remedies,
  };
}

// ─── native modules ───────────────────────────────────────────────────────────

const NATIVE_MODULE = 'better-sqlite3';

/**
 * Both numbers Node puts in an ABI-mismatch message:
 * `... compiled against a different Node.js version using NODE_MODULE_VERSION 127. This
 * version of Node.js requires NODE_MODULE_VERSION 130.`
 */
const NODE_MODULE_VERSION = /NODE_MODULE_VERSION (\d+)/g;

export interface NativeModuleDiagnosis {
  state: 'missing' | 'broken';
  detail: string;
  remedies: Remedy[];
  /** The ABI the file on disk was compiled for. Present only for a mismatch. */
  builtFor?: number;
  /** The ABI this runtime loads. Present only for a mismatch. */
  required?: number;
}

/**
 * Turns a module-load failure into something the user can act on.
 *
 * The distinction that matters: an ABI mismatch is **`broken`, not `missing`**. The file is
 * present and intact; it was simply compiled for the wrong runtime. Reporting it as missing
 * would send the user off to reinstall a package that is already there, and the single
 * sentence naming Node and Electron is what turns an hour of confusion into one command.
 */
export function diagnoseNativeModuleError(err: unknown): NativeModuleDiagnosis {
  const message = err instanceof Error ? err.message : String(err);
  const versions = [...message.matchAll(NODE_MODULE_VERSION)].map((m) => Number(m[1]));

  if (versions.length >= 2) {
    const builtFor = versions[0]!;
    const required = versions[1]!;
    return {
      state: 'broken',
      builtFor,
      required,
      detail:
        `${NATIVE_MODULE} is installed but was built for NODE_MODULE_VERSION ${builtFor} — that is a ` +
        `Node.js build — and this is Electron, which loads NODE_MODULE_VERSION ${required}. The file is ` +
        'there and undamaged; it is compiled for the wrong runtime. Rebuilding it against Electron fixes it.',
      remedies: [
        {
          kind: 'command',
          labelKey: 'preflight.remedy.rebuild',
          command: ELECTRON_REBUILD_COMMAND,
        },
      ],
    };
  }

  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'MODULE_NOT_FOUND' || /Cannot find module/i.test(message)) {
    return {
      state: 'missing',
      detail: `${NATIVE_MODULE} is not installed, so LocalCast has no database to open.`,
      remedies: [
        { kind: 'command', labelKey: 'preflight.remedy.install', command: NPM_INSTALL_COMMAND },
      ],
    };
  }

  return {
    state: 'broken',
    detail: `${NATIVE_MODULE} could not be loaded: ${message}`,
    remedies: [
      { kind: 'command', labelKey: 'preflight.remedy.rebuild', command: ELECTRON_REBUILD_COMMAND },
    ],
  };
}

const nodeRequire = createRequire(import.meta.url);

/**
 * Opens a database for real, in this process, through the binding the app will use.
 *
 * A bare `require('better-sqlite3')` is not enough and was the original bug here: the package
 * loads its JavaScript eagerly and only `dlopen`s the binding when a `Database` is
 * constructed, so requiring it succeeds even when the binding is unloadable. The check has to
 * open something.
 *
 * It must also go through `nativeBinding`. node_modules deliberately holds the Node-ABI build
 * so the test suite runs, while the app loads its own Electron-ABI copy from beside the tree;
 * inspecting node_modules would condemn a perfectly working install.
 */
export function detectNativeModules(
  nativeBinding = '',
  load: (binding: string) => unknown = (binding) => {
    const Database = nodeRequire(NATIVE_MODULE) as new (path: string, opts?: unknown) => { close(): void };
    const db = binding ? new Database(':memory:', { nativeBinding: binding }) : new Database(':memory:');
    db.close();
    return db;
  },
): PrerequisiteStatus {
  const searchedPaths: string[] = [];
  if (nativeBinding) searchedPaths.push(nativeBinding);
  try {
    searchedPaths.push(nodeRequire.resolve(NATIVE_MODULE));
  } catch {
    // Unresolvable is itself reported by the load below, with a remedy attached.
  }

  try {
    load(nativeBinding);
    return {
      id: 'native-modules',
      severity: 'blocking',
      state: 'ok',
      searchedPaths,
      detail: '',
      remedies: [],
    };
  } catch (err) {
    const diagnosis = diagnoseNativeModuleError(err);
    return {
      id: 'native-modules',
      severity: 'blocking',
      state: diagnosis.state,
      searchedPaths,
      detail: diagnosis.detail,
      remedies: diagnosis.remedies,
    };
  }
}
