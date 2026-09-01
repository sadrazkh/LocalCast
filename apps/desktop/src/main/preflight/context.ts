/**
 * The directories the prerequisite checks look in.
 *
 * Passed in rather than read from `electron.app` inside each detector, for two reasons: the
 * detectors can then be exercised without an Electron runtime, and the paths they report back
 * to the user are exactly the ones `index.ts` already computed for the server and the sidecar
 * rather than a second, subtly different guess at them.
 */
export interface PreflightContext {
  /** `app.getAppPath()`. */
  appRoot: string;
  /** `process.resourcesPath`. */
  resourcesPath: string;
  /** The repository root in development; the app directory in a packaged build. */
  repoRoot: string;
  /** `vendor/bin` in development, `resources/vendor` when packaged. */
  vendorDir: string;
  /**
   * The `better_sqlite3.node` the app will actually load, or '' to use node_modules.
   *
   * The check has to open a database through this exact path. node_modules deliberately
   * holds the Node-ABI build so the test suite works, and the app loads its own Electron-ABI
   * copy from beside the tree — so a detector that inspected node_modules would condemn a
   * perfectly working install.
   */
  nativeBinding: string;
}
