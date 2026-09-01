/**
 * Digit and pairing-code normalisation.
 *
 * This lives in client-core rather than ui-kit because it is protocol behaviour, not
 * presentation: the Electron main process normalises a typed code before claiming a pairing,
 * and pulling a React package into the main process to reach one string helper would be
 * absurd. `ui-kit` re-exports these so every surface still has one definition.
 */

/** Extended Arabic-Indic (Persian) ۰-۹ and Arabic-Indic ٠-٩; both reach us from iOS keyboards. */
const ASCII_DIGIT_BY_CODE_POINT = new Map<string, string>();
for (let d = 0; d < 10; d += 1) {
  ASCII_DIGIT_BY_CODE_POINT.set(String.fromCharCode(0x06f0 + d), String(d));
  ASCII_DIGIT_BY_CODE_POINT.set(String.fromCharCode(0x0660 + d), String(d));
}

/**
 * Maps Persian and Arabic-Indic digits back to ASCII, and normalises the Persian decimal
 * and grouping marks. Every value that goes back to the server — a typed pairing code, a
 * host, a port — passes through here first.
 */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    out += ASCII_DIGIT_BY_CODE_POINT.get(ch) ?? ch;
  }
  return out.replace(/٫/g, '.').replace(/٬/g, ',');
}

/**
 * A pairing code. **Always ASCII**, upper-cased, whitespace and separators stripped.
 *
 * This is also the normaliser for what the user types: an iOS Persian keyboard produces
 * «۱۲۳۴», and the server only ever minted `1234`. Comparing the two without this step is a
 * pairing failure that looks like a wrong code.
 */
export function formatCode(code: string): string {
  return toAsciiDigits(code).replace(/[\s-]/g, '').toUpperCase();
}
