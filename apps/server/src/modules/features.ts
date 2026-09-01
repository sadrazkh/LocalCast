/**
 * Build-time feature switches for the server's feature modules.
 *
 * The server cannot read `apps/desktop/src/shared/features.ts`: it is a published workspace
 * that must build and run without an Electron app anywhere near it — `apps/server/test` and
 * `npm run dev` both start it on bare Node. So the same switch is declared here, and the two
 * are kept in step by hand.
 */

/**
 * Whether the print module is registered at all.
 *
 * **Off for now, on purpose, and this is a switch rather than a deletion.** Printing needs
 * `vendor/bin/SumatraPDF.exe`, which is not committed and is not installed on the machine the
 * owner is testing on. While that is true the feature contributes nothing but noise — a
 * prerequisite on the setup screen, two lines in `npm run doctor`, a print button on every
 * file — to somebody trying to get the plain local-network path working.
 *
 * Nothing about the module has been removed. `modules/print/**` is intact and its ~180 tests
 * still run against it directly, because they test the module, not the app's decision to
 * expose it. Turning printing back on is this one constant, plus its two siblings:
 *
 *   - `apps/desktop/src/shared/features.ts` — the desktop preflight screen
 *   - `scripts/features.mjs`               — `npm run doctor` and `scripts/prepack.mjs`
 *
 * When it is `false`, `modules/index.ts` registers `createPrintDisabledModule()` in place of
 * the real one, so the routes still answer with a typed "this is switched off" rather than a
 * 404 that reads like a bug.
 *
 * Typed `boolean` rather than left as the literal `false`, matching the desktop file: with the
 * literal type TypeScript narrows the guarded branch to unreachable and stops checking inside
 * it, so the switched-off path would rot unnoticed until the day it is switched back on.
 */
export const PRINTING_ENABLED: boolean = false;
