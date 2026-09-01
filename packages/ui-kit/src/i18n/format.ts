import { formatCode, toAsciiDigits } from '@localcast/client-core';
import type { Locale } from './locale.js';

/**
 * Number and date formatting, and the one rule that everything else in this file exists to
 * enforce:
 *
 *   **Persian numerals for user-facing counts and dates. ASCII digits for addresses, byte
 *   sizes, pairing codes, durations — anything the user might copy, type back, or compare
 *   against something a machine printed.**
 *
 * The reason is not aesthetic. `۱۹۲٫۱۶۸٫۱٫۳۱` cannot be pasted into a terminal, a pairing
 * code in Persian digits cannot be matched against what the server minted, and «۱٫۴ گیگابایت»
 * loses against `1.4 GB` the moment anyone has to compare it with what Explorer shows.
 * Counts and dates have the opposite pull: they are read, not copied, and a Persian-first
 * product that renders «12 files» in the middle of a Persian sentence looks unfinished.
 *
 * Components must call these helpers and never `toLocaleString` directly. That is what keeps
 * the split from decaying one component at a time.
 *
 * Nothing here injects bidi control characters. An ASCII string sitting in an RTL paragraph
 * is isolated with CSS (`direction: ltr; unicode-bidi: isolate` on the element that holds
 * it), because a U+2066 embedded in the text would travel with a copy-paste and break the
 * value it was meant to protect.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** U+066C ARABIC THOUSANDS SEPARATOR — the grouping mark Persian typography uses. */
const PERSIAN_GROUP_SEPARATOR = '٬';

// `toAsciiDigits` and `formatCode` are protocol normalisation, not presentation — the
// Electron main process needs them to claim a pairing, and it has no business importing a
// React package. They live in client-core and are re-exported here so every surface keeps
// using one definition.
// Imported above as well: `export … from` re-exports without creating a local binding, and
// `formatAddress` and `formatDate` below both call `toAsciiDigits`.
export { formatCode, toAsciiDigits };

/** Maps ASCII digits in `input` to Persian ones. Idempotent: Persian digits pass through. */
export function toPersianDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

function groupAscii(digits: string, separator: string): string {
  // Right-to-left grouping by threes, done by hand so the output does not depend on ICU
  // having Persian data loaded. Node ships full ICU today; the installer's Node may not.
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += separator;
  }
  return out;
}

/**
 * A user-facing count: files in a folder, connected devices, copies in the queue.
 * Persian digits and «٬» grouping under `fa`; ASCII and `,` under `en`.
 */
export function formatCount(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return '—';
  const negative = value < 0;
  const rounded = Math.abs(Math.round(value));
  const grouped = groupAscii(
    String(rounded),
    locale === 'fa' ? PERSIAN_GROUP_SEPARATOR : ',',
  );
  const signed = negative ? `-${grouped}` : grouped;
  return locale === 'fa' ? toPersianDigits(signed) : signed;
}

/**
 * A user-facing fraction rendered as a percentage. Same digit rule as `formatCount`.
 * `value` is 0…1, not 0…100.
 */
export function formatPercent(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return '—';
  const clamped = Math.min(1, Math.max(0, value));
  const whole = Math.round(clamped * 100);
  return locale === 'fa' ? `${toPersianDigits(String(whole))}٪` : `${whole}%`;
}

export type DateStyle = 'date' | 'datetime' | 'time';

const DATE_FIELDS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  datetime: {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
  time: { hour: '2-digit', minute: '2-digit' },
};

/**
 * A user-facing date. Persian digits and the Persian (Jalali) calendar under `fa` — an
 * operator in Tehran reads «۱۴۰۵ مرداد ۱۰», not a Gregorian date in Persian numerals.
 *
 * `value` is epoch milliseconds (what the contract carries) or a `Date`.
 */
export function formatDate(
  value: number | Date,
  locale: Locale,
  style: DateStyle = 'date',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const fields = DATE_FIELDS[style];
  try {
    // `-u-ca-persian` is explicit rather than relying on `fa-IR`'s default calendar, and
    // `-nu-latn` asks for ASCII digits so the Persian mapping below is the only thing that
    // decides digit shape. Without it the result depends on which ICU build is loaded.
    const tag = locale === 'fa' ? 'fa-IR-u-ca-persian-nu-latn' : 'en-GB';
    const text = new Intl.DateTimeFormat(tag, fields).format(date);
    return locale === 'fa' ? toPersianDigits(text) : toAsciiDigits(text);
  } catch {
    // A Node build without Persian calendar data must still render something legible
    // rather than throwing inside a render pass.
    const iso = date.toISOString().slice(0, style === 'time' ? 16 : 10).replace('T', ' ');
    return locale === 'fa' ? toPersianDigits(iso) : iso;
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * A byte size. **Always ASCII**, in both locales, because it is compared against what
 * Windows Explorer and every other tool on the machine shows, and because the operator
 * pastes it into support threads.
 *
 * 1024-based, matching Explorer. The unit abbreviation stays Latin for the same reason.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 100, none above — 9.4 GB reads better than 9 GB, 412 MB better
  // than 412.3 MB.
  const decimals = value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

/**
 * A duration: video position, pairing-code countdown, server uptime. **Always ASCII** — it
 * is monospace, it sits next to a scrubber, and it is compared with a player's own clock.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A host, optionally with a port. **Always ASCII**, always exactly what a client would have
 * to type. Persian digits here would produce an address nobody can use.
 *
 * IPv6 literals are bracketed when a port is attached, so `formatAddress('fd7a::1', 443)`
 * is `[fd7a::1]:443` and not an ambiguous colon soup.
 */
export function formatAddress(host: string, port?: number | null): string {
  const bare = toAsciiDigits(host).trim();
  if (port === undefined || port === null || !Number.isFinite(port)) return bare;
  const needsBrackets = bare.includes(':') && !bare.startsWith('[');
  const left = needsBrackets ? `[${bare}]` : bare;
  return `${left}:${Math.trunc(port)}`;
}

