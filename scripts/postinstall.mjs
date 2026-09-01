/**
 * Runs automatically after `npm install`, so a fresh clone is launchable without anyone
 * having to know the native-module story. See scripts/rebuild-native.mjs for what that is.
 *
 * Two deliberate softenings:
 *
 * - **No Electron, no work.** Someone who cloned this to run the server tests, and a CI job
 *   that installs with `--omit=dev`, must not have a desktop toolchain forced on them.
 * - **A failure here does not fail `npm install`.** A rebuild needs a C++ toolchain, and on a
 *   machine without one the right outcome is an installed tree plus a message saying exactly
 *   what to run once the toolchain is there — not an install that rolls back and leaves the
 *   person unable to run anything at all. `npm run doctor` reports the same problem later,
 *   and that one does exit non-zero.
 */
import { ensureNativeModules } from './rebuild-native.mjs';

try {
  ensureNativeModules();
} catch (err) {
  console.warn('\npostinstall: could not rebuild the native modules for Electron.');
  console.warn(err instanceof Error ? err.message : String(err));
  console.warn(
    '\nThe install itself is fine. The desktop app will refuse to start until this is done:\n' +
      '  npm run rebuild:native\n' +
      'Details and prerequisites: docs/prerequisites.md\n',
  );
}
