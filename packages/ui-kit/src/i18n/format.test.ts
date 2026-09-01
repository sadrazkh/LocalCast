import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  formatBytes,
  formatCode,
  formatCount,
  formatDate,
  formatDuration,
  formatPercent,
  toAsciiDigits,
  toPersianDigits,
} from './format.js';

const PERSIAN_DIGIT = /[۰-۹]/;
const ASCII_DIGIT = /[0-9]/;

/** 2026-09-01T10:20:30Z — a fixed instant, so nothing here depends on the clock. */
const INSTANT = Date.UTC(2026, 8, 1, 10, 20, 30);

describe('digit primitives', () => {
  it('maps ASCII to Persian and back', () => {
    expect(toPersianDigits('2026')).toBe('۲۰۲۶');
    expect(toAsciiDigits('۲۰۲۶')).toBe('2026');
  });

  it('accepts Arabic-Indic digits, which iOS keyboards also produce', () => {
    expect(toAsciiDigits('٢٠٢٦')).toBe('2026');
  });

  it('is idempotent, so a value can be normalised twice without harm', () => {
    expect(toPersianDigits(toPersianDigits('7'))).toBe('۷');
    expect(toAsciiDigits(toAsciiDigits('۷'))).toBe('7');
  });
});

describe('formatCount — a user-facing number', () => {
  it('uses Persian digits and the Persian thousands mark under fa', () => {
    expect(formatCount(1234, 'fa')).toBe('۱٬۲۳۴');
  });

  it('uses ASCII digits and a comma under en', () => {
    expect(formatCount(1234, 'en')).toBe('1,234');
  });

  it('leaves no ASCII digit anywhere in a Persian count', () => {
    expect(ASCII_DIGIT.test(formatCount(9_876_543, 'fa'))).toBe(false);
  });

  it('groups by threes from the end', () => {
    expect(formatCount(1_000_000, 'en')).toBe('1,000,000');
    expect(formatCount(999, 'en')).toBe('999');
  });

  it('survives values that are not numbers', () => {
    expect(formatCount(Number.NaN, 'fa')).toBe('—');
  });
});

describe('formatPercent', () => {
  it('follows the same digit rule as a count', () => {
    expect(formatPercent(0.42, 'fa')).toBe('۴۲٪');
    expect(formatPercent(0.42, 'en')).toBe('42%');
  });

  it('clamps out-of-range fractions', () => {
    expect(formatPercent(1.9, 'en')).toBe('100%');
    expect(formatPercent(-3, 'en')).toBe('0%');
  });
});

describe('formatDate — a user-facing date', () => {
  it('renders Persian digits under fa', () => {
    const text = formatDate(INSTANT, 'fa');
    expect(PERSIAN_DIGIT.test(text)).toBe(true);
    expect(ASCII_DIGIT.test(text)).toBe(false);
  });

  it('renders ASCII digits under en', () => {
    const text = formatDate(INSTANT, 'en');
    expect(ASCII_DIGIT.test(text)).toBe(true);
    expect(PERSIAN_DIGIT.test(text)).toBe(false);
  });

  it('keeps the digit rule for the datetime and time styles too', () => {
    expect(ASCII_DIGIT.test(formatDate(INSTANT, 'fa', 'datetime'))).toBe(false);
    expect(ASCII_DIGIT.test(formatDate(INSTANT, 'fa', 'time'))).toBe(false);
  });

  it('does not throw on an invalid instant', () => {
    expect(formatDate(Number.NaN, 'fa')).toBe('—');
  });
});

describe('formatBytes — copyable, therefore ASCII in every locale', () => {
  it('keeps ASCII digits and a Latin unit', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024 * 1024 * 1024 * 4.2)).toBe('4.2 GB');
  });

  it('drops the decimal above 100 of a unit', () => {
    expect(formatBytes(412 * 1024 * 1024)).toBe('412 MB');
  });

  it('contains no Persian digit, whatever the locale of the surrounding UI', () => {
    expect(PERSIAN_DIGIT.test(formatBytes(18_000_000_000))).toBe(false);
  });
});

describe('formatDuration — a scrubber value, therefore ASCII', () => {
  it('drops the hour component below an hour', () => {
    expect(formatDuration(75)).toBe('1:15');
  });

  it('pads minutes and seconds once there are hours', () => {
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('renders a placeholder rather than NaN', () => {
    expect(formatDuration(Number.NaN)).toBe('--:--');
  });

  it('never emits a Persian digit', () => {
    expect(PERSIAN_DIGIT.test(formatDuration(3725))).toBe(false);
  });
});

describe('formatAddress — typed into other machines, therefore ASCII', () => {
  it('joins host and port', () => {
    expect(formatAddress('ali-pc.tail1234.ts.net', 443)).toBe('ali-pc.tail1234.ts.net:443');
  });

  it('normalises Persian digits a keyboard may have produced', () => {
    expect(formatAddress('۱۹۲.۱۶۸.۱.۳۱')).toBe('192.168.1.31');
  });

  it('brackets an IPv6 literal before appending a port', () => {
    expect(formatAddress('fd7a::1', 443)).toBe('[fd7a::1]:443');
  });

  it('leaves the host alone when no port is given', () => {
    expect(formatAddress('localcast.tail1234.ts.net')).toBe('localcast.tail1234.ts.net');
  });
});

describe('formatCode — read aloud and typed back, therefore ASCII', () => {
  it('normalises Persian digits to ASCII', () => {
    expect(formatCode('۱۲۳۴')).toBe('1234');
  });

  it('upper-cases and strips separators', () => {
    expect(formatCode(' a1-b2 ')).toBe('A1B2');
  });
});

describe('the split the whole file exists to enforce', () => {
  it('gives a count Persian digits while a byte size and an address keep ASCII', () => {
    const count = formatCount(1024, 'fa');
    const size = formatBytes(1024);
    const address = formatAddress('100.64.0.7', 443);
    const code = formatCode('7f3a');

    expect(PERSIAN_DIGIT.test(count)).toBe(true);
    expect(ASCII_DIGIT.test(count)).toBe(false);

    expect(PERSIAN_DIGIT.test(size)).toBe(false);
    expect(ASCII_DIGIT.test(size)).toBe(true);

    expect(PERSIAN_DIGIT.test(address)).toBe(false);
    expect(address).toBe('100.64.0.7:443');

    expect(PERSIAN_DIGIT.test(code)).toBe(false);
  });

  it('holds under en as well, where only the count changes shape', () => {
    expect(formatCount(1024, 'en')).toBe('1,024');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatAddress('100.64.0.7', 443)).toBe('100.64.0.7:443');
  });
});
