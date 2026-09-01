/**
 * The two locales and the direction rule. Kept in its own module so `format.ts` can depend
 * on it without importing the React context from `index.ts` (which imports `format.ts`).
 */
export type Locale = 'fa' | 'en';
export type Direction = 'rtl' | 'ltr';

export const LOCALES: readonly Locale[] = ['fa', 'en'];

/** Persian is the primary language, so `fa` is the default everywhere. */
export const DEFAULT_LOCALE: Locale = 'fa';

export function directionOf(locale: Locale): Direction {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

/** BCP-47 tag for `Intl`. `fa-IR` selects the Persian calendar by default; we ask anyway. */
export function bcp47(locale: Locale): string {
  return locale === 'fa' ? 'fa-IR' : 'en-GB';
}
