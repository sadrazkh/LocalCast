/**
 * Feature switches for the repository's own tooling — `npm run doctor` and `scripts/prepack.mjs`.
 *
 * Plain ESM with no dependencies, on purpose. `doctor.mjs` runs from a fresh clone before
 * anything has been built or type-checked, and its whole value is that it works when the app
 * does not; importing a TypeScript module from `apps/` would make the tool that explains a
 * broken install need a working install.
 */

/**
 * Whether this build can print. See `apps/server/src/modules/features.ts` for the full reason
 * printing is switched off; the short version is that it needs `vendor/bin/SumatraPDF.exe`,
 * which is not committed, and a prerequisites report that keeps demanding a helper for a
 * feature nobody can reach is noise in front of the thing being tested.
 *
 * A switch, not a deletion: `modules/print/**` and its tests are untouched. Turn it back on
 * here **and** in the two other declarations, which exist because the three consumers may not
 * import each other:
 *
 *   - `apps/server/src/modules/features.ts`   — module registration
 *   - `apps/desktop/src/shared/features.ts`   — the desktop preflight screen
 */
export const PRINTING_ENABLED = false;
