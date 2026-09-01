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
}
