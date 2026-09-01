import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { fa } from './fa.js';
import type { MessageKey } from './fa.js';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const PLACEHOLDER = /\{(\w+)\}/g;

const keys = Object.keys(fa) as MessageKey[];

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '').sort();
}

describe('the message catalogues', () => {
  it('has a non-trivial number of keys', () => {
    expect(keys.length).toBeGreaterThan(150);
  });

  it('covers exactly the same keys in both languages', () => {
    // `en` is typed as `Messages`, so this is already a compile error — asserted at runtime
    // too because the types do not survive into a built app that hand-edits a catalogue.
    expect(Object.keys(en).sort()).toEqual([...keys].sort());
  });

  it('has no empty message in either language', () => {
    for (const key of keys) {
      expect(fa[key].trim(), `fa: ${key}`).not.toBe('');
      expect(en[key].trim(), `en: ${key}`).not.toBe('');
    }
  });

  it('leaves no Persian text in the English catalogue', () => {
    const leaked = keys.filter((key) => ARABIC_SCRIPT.test(en[key]));
    expect(leaked).toEqual([]);
  });

  it('translates rather than copies, apart from proper nouns', () => {
    // A key whose two values are identical is either a proper noun or a missed translation.
    const identical = keys.filter((key) => fa[key] === en[key]);
    expect(identical.sort()).toEqual(
      ['app.name', 'devices.platform.webdav', 'print.pageRangePlaceholder'].sort(),
    );
  });

  it('uses the same placeholders on both sides', () => {
    for (const key of keys) {
      expect(placeholders(en[key]), `key: ${key}`).toEqual(placeholders(fa[key]));
    }
  });

  it('hard-codes no Persian digit, so the format helpers stay the only source of them', () => {
    // «کد ۴ رقمی» is the exception: the canvas's own wording, a fixed literal rather than a
    // formatted value, so it does not go through `formatCount`.
    const allowed = new Set<MessageKey>(['pairing.codeFallback', 'pairing.codeFallbackAction']);
    const offenders = keys.filter((key) => !allowed.has(key) && /[۰-۹]/.test(fa[key]));
    expect(offenders).toEqual([]);
  });
});
