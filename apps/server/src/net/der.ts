/**
 * Just enough DER to write one X.509 certificate.
 *
 * Node can *parse* certificates (`crypto.X509Certificate`) and sign arbitrary bytes, but it
 * cannot build a certificate, and nothing in this repository's dependency tree can either —
 * `npm ls node-forge` and `npm ls selfsigned` both come back empty, and neither appears in
 * `package-lock.json`. Rather than pull a package into a tree that ships inside an Electron
 * installer, the ~150 lines of ASN.1 that a self-signed leaf certificate actually needs are
 * written here.
 *
 * This is a *writer*, not a parser: it never has to cope with hostile input, indefinite
 * lengths, or any tag it did not itself emit. That is what keeps it small enough to read. The
 * output is checked against a real parser at generation time (`selfSigned.ts` re-reads what it
 * wrote through `X509Certificate` and verifies the signature), and against OpenSSL by the
 * tests, which complete a genuine TLS handshake against it.
 */

/** The handful of universal tags this file emits. */
const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Tag/length/value. Long-form lengths are emitted whenever the payload reaches 128 bytes. */
export function tlv(tag: number, value: Buffer): Buffer {
  if (value.length < 0x80) {
    return Buffer.concat([Buffer.from([tag, value.length]), value]);
  }
  const size: number[] = [];
  for (let n = value.length; n > 0; n = Math.floor(n / 256)) size.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | size.length, ...size]), value]);
}

export function sequence(...parts: Buffer[]): Buffer {
  return tlv(TAG.SEQUENCE, Buffer.concat(parts));
}

export function set(...parts: Buffer[]): Buffer {
  return tlv(TAG.SET, Buffer.concat(parts));
}

/**
 * A `[n] EXPLICIT` wrapper — the constructed context-specific tag X.509 uses for the version
 * field and the extensions block.
 */
export function explicit(n: number, ...parts: Buffer[]): Buffer {
  return tlv(0xa0 | n, Buffer.concat(parts));
}

/** A `[n] IMPLICIT` primitive wrapper — how `GeneralName` alternatives are tagged. */
export function implicitPrimitive(n: number, value: Buffer): Buffer {
  return tlv(0x80 | n, value);
}

export function boolean(value: boolean): Buffer {
  return tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
}

export function integer(value: number): Buffer {
  if (value === 0) return tlv(TAG.INTEGER, Buffer.from([0]));
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  // DER integers are signed, so a leading byte with the high bit set would read as negative.
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return tlv(TAG.INTEGER, Buffer.from(bytes));
}

/** A positive INTEGER from raw bytes — used for the serial number. */
export function positiveInteger(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const trimmed = raw.subarray(start);
  const needsPad = ((trimmed[0] as number) & 0x80) !== 0;
  return tlv(TAG.INTEGER, needsPad ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

export function octetString(value: Buffer): Buffer {
  return tlv(TAG.OCTET_STRING, value);
}

export function utf8String(value: string): Buffer {
  return tlv(TAG.UTF8_STRING, Buffer.from(value, 'utf8'));
}

/**
 * A BIT STRING whose content is a whole number of bytes. `unusedBits` is only non-zero for
 * flag fields such as `KeyUsage`, where the trailing bits of the last byte carry no meaning.
 */
export function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), value]));
}

/** Dotted-decimal to DER. The first two arcs share one byte; the rest are base-128. */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (arcs.length < 2 || arcs.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`not an object identifier: ${dotted}`);
  }
  const bytes: number[] = [40 * (arcs[0] as number) + (arcs[1] as number)];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [];
    let value = arc;
    do {
      chunk.unshift(value % 128);
      value = Math.floor(value / 128);
    } while (value > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] as number) | 0x80;
    bytes.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/**
 * A validity timestamp. RFC 5280 §4.1.2.5 is explicit that dates through 2049 are `UTCTime`
 * and dates from 2050 are `GeneralizedTime`; a parser that sees the wrong one may reject the
 * certificate outright, so the switch is not optional even though nothing this app issues
 * today lives that long.
 */
export function time(date: Date): Buffer {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return year < 2050
    ? tlv(TAG.UTC_TIME, Buffer.from(pad(year % 100) + rest, 'ascii'))
    : tlv(TAG.GENERALIZED_TIME, Buffer.from(pad(year, 4) + rest, 'ascii'));
}

/** DER bytes wrapped as PEM, 64 base64 characters to a line as RFC 7468 requires. */
export function toPem(label: string, der: Buffer): string {
  const encoded = der.toString('base64');
  // Chunked by hand rather than with a regex: `replace(/(.{64})/g, '$1\n')` leaves a blank
  // line whenever the payload is an exact multiple of 64 characters, and some PEM readers
  // treat that as the end of the object.
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 64) lines.push(encoded.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
