/**
 * Build-time switches for whole features.
 *
 * **Why a flag and not a deletion.** Remote access — the sidecar, the coordination server,
 * the one sign-in LocalCast has — is finished code that works. It is switched off because it
 * was standing in front of everything else: the first-run wizard demanded a sign-in before
 * the app would do anything, which contradicts the product's central promise that on your own
 * Wi-Fi it needs no account. Deleting it would throw away working code and its tests to fix a
 * sequencing problem; a constant turns it off today and back on in one edit and a rebuild.
 *
 * **Why one constant, imported everywhere.** The main process must not spawn the sidecar, the
 * prerequisites screen must not mention it, the wizard must not step through it and the panel
 * must not offer it. If each of those decided for itself, re-enabling would be an archaeology
 * exercise and one of them would be missed — which is how a feature comes back half on.
 *
 * These are deliberately typed as `boolean` rather than left as literal `false`. With the
 * literal type TypeScript narrows every guarded branch to unreachable and stops checking what
 * is inside it, so the switched-off code would rot silently until the day it is switched back
 * on. Widening keeps both sides of every flag compiled and type-checked.
 */

/**
 * Reaching this machine from another network: the `netedge` sidecar, the coordination
 * server, the account, the wizard's sign-in step and the network settings panel.
 *
 * Off. The stored `remoteAccess` preference in `config.json` is untouched by this — it stays
 * the user's answer, and this flag only overrides it while it is false, so someone who had
 * remote access turned on gets it back the day this becomes `true`.
 */
export const REMOTE_ACCESS_ENABLED: boolean = false;

/**
 * Printing from a phone to a printer attached to this machine.
 *
 * Off, for the same shape of reason as the flag above and with the same promise attached: the
 * print module is 180 passing tests and four real defects' worth of work, and none of it has
 * been deleted. What it needs is `vendor/bin/SumatraPDF.exe`, which is not committed and is not
 * on the machine this is being tested on — so while the flag is false the only thing printing
 * contributes is a prerequisite nobody can satisfy, sitting on the first screen of a setup that
 * is trying to get the plain local-network path working.
 *
 * Here this governs the prerequisites screen: `main/preflight/run.ts` does not run the
 * print-helper detector at all, so the screen has nothing to say about SumatraPDF, and
 * `main/preflight/ipc.ts` refuses to download it if a stale renderer asks anyway.
 *
 * Two more declarations have to move with this one — they exist because the three consumers
 * cannot import each other (the server is a published workspace that must not import from an
 * Electron app; `npm run doctor` must run before anything is built):
 *
 *   - `apps/server/src/modules/features.ts` — whether the print module registers
 *   - `scripts/features.mjs`                — `npm run doctor` and `scripts/prepack.mjs`
 */
export const PRINTING_ENABLED: boolean = false;
