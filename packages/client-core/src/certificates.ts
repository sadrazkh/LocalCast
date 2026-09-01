import type { QrPayload } from '@localcast/contract';

/**
 * Certificate pinning for the local network.
 *
 * On the LAN a LocalCast server presents a certificate it issued to itself. No certificate
 * authority is installed on any device, so nothing in a normal trust store can vouch for it —
 * a browser shows its warning and a person decides. A native client has a better option, and
 * must take it: the server publishes the certificate's SHA-256 fingerprint in the QR payload,
 * and the client checks the certificate it was handed against that exact value.
 *
 * **The tempting shortcut is the dangerous one.** `rejectUnauthorized: false` (or an Electron
 * `setCertificateVerifyProc` that returns 0 for everything) turns "encrypted" into "encrypted
 * to whoever answered": anyone able to answer on that address — another machine on a café
 * Wi-Fi, a router that has been got at — gets a working session and the bearer token that
 * comes with it. Pinning is what makes the self-signed certificate honest. Nothing in this
 * package ever disables verification, and nothing that imports it should either.
 *
 * The awkward part is that every layer spells a fingerprint differently:
 *
 *   - Node's `tls` and `crypto.X509Certificate`  `AB:CD:…`  (uppercase hex, colons)
 *   - Electron's `Certificate.fingerprint`       `sha256/uKQ…=`  (base64, prefixed)
 *   - OpenSSL `-fingerprint -sha256`             `SHA256 Fingerprint=AB:CD:…`
 *   - people pasting from a terminal             lowercase, or with the colons stripped
 *
 * All four mean the same 32 bytes, so all four are accepted and normalised to one spelling
 * before anything is compared. A comparison that fails because of punctuation is a
 * comparison someone will eventually "fix" by removing it.
 */

/** The canonical spelling: 32 uppercase hex pairs joined by colons, as Node prints them. */
export type Fingerprint = string;

const HEX_32_BYTES = /^[0-9A-F]{64}$/;

function fromHex(hex: string): Fingerprint | null {
  if (!HEX_32_BYTES.test(hex)) return null;
  return (hex.match(/.{2}/g) ?? []).join(':');
}

function fromBase64(value: string): Fingerprint | null {
  // Base64 of 32 bytes is 44 characters including the single `=` pad.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length !== 32) return null;
    return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  } catch {
    return null;
  }
}

/**
 * Decoded by hand rather than through `atob` or `Buffer`: this package runs in a browser, in
 * an Electron main process and on whatever an Android port supplies, and exactly one of those
 * three has each of those globals.
 */
function base64ToBytes(value: string): Uint8Array {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('not base64');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Normalise any of the common spellings, or return null when the input is not a SHA-256
 * fingerprint at all. Null is a refusal, never a pass: a caller must treat it as "cannot
 * verify" and fail the connection.
 */
export function normaliseFingerprint(value: string | null | undefined): Fingerprint | null {
  if (typeof value !== 'string') return null;

  let text = value.trim();
  // `SHA256 Fingerprint=AB:CD:…`, as `openssl x509 -fingerprint` prints it.
  const equals = text.lastIndexOf('=');
  if (/fingerprint/i.test(text) && equals >= 0) text = text.slice(equals + 1).trim();

  // `sha256/<base64>` or `sha256:<hex>`.
  const prefix = /^sha-?256\s*[/:]\s*/i.exec(text);
  if (prefix) {
    const rest = text.slice(prefix[0].length).trim();
    return fromBase64(rest) ?? fromHex(rest.replace(/[\s:-]/g, '').toUpperCase());
  }

  const base64 = fromBase64(text);
  if (base64 !== null) return base64;

  return fromHex(text.replace(/[\s:-]/g, '').toUpperCase());
}

/**
 * Constant-time-ish equality over two fingerprints in any spelling.
 *
 * Timing is not actually a concern here — a fingerprint is public, and an attacker who can
 * measure this already controls the client — but the loop is written without an early exit
 * anyway, because the next person to copy this function may not be comparing something
 * public.
 */
export function fingerprintsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normaliseFingerprint(a);
  const right = normaliseFingerprint(b);
  if (left === null || right === null) return false;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/** Where to connect, and what to pin when you get there. */
export interface ServerEndpoint {
  /** Absolute origin, no trailing slash. */
  baseUrl: string;
  /**
   * The certificate to pin, or null when the server presents an ordinary publicly-trusted
   * one and must be verified the normal way.
   *
   * **Null does not mean "skip verification."** It means the opposite: verify against the
   * platform trust store, exactly as for any other HTTPS connection.
   */
  pinnedFingerprint: Fingerprint | null;
}

/**
 * The endpoint a QR payload describes.
 *
 * `url` wins when it is there, because it is the only field that can express the local
 * network's shape: a bare IP, a non-standard port, and a certificate that will never chain to
 * a public root. `host` is the tailnet name, which is reached over ordinary HTTPS on 443 and
 * needs no pin.
 */
export function endpointFromQr(payload: QrPayload): ServerEndpoint {
  if (payload.url !== undefined && payload.url.length > 0) {
    return {
      baseUrl: payload.url.replace(/\/+$/, ''),
      pinnedFingerprint: normaliseFingerprint(payload.fp),
    };
  }
  return { baseUrl: `https://${payload.host}`, pinnedFingerprint: null };
}
