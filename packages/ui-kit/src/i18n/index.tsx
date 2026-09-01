import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { fa } from './fa.js';
import type { MessageKey, Messages } from './fa.js';
import { en } from './en.js';
import { DEFAULT_LOCALE, directionOf } from './locale.js';
import type { Direction, Locale } from './locale.js';
import {
  formatAddress,
  formatBytes,
  formatCode,
  formatCount,
  formatDate,
  formatDuration,
  formatPercent,
} from './format.js';
import type { DateStyle } from './format.js';
import { cx } from '../utils/cx.js';

export const catalogues: Record<Locale, Messages> = { fa, en };

export type TranslateVars = Readonly<Record<string, string | number>>;

/**
 * `key` is the union of catalogue keys, so a typo or a message that was never translated is
 * a compile error. There is deliberately no `string` overload and no default-value
 * parameter: both are the escape hatches through which untranslated English leaks into a
 * Persian screen.
 */
export type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string;

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export interface LocaleContextValue {
  readonly locale: Locale;
  readonly dir: Direction;
  readonly messages: Messages;
  readonly t: TranslateFn;
  readonly setLocale: (next: Locale) => void;
}

/**
 * The default value is a working Persian context rather than `null`.
 *
 * A component rendered outside a provider should look wrong-language, not crash — a thrown
 * "useT must be used within LocaleProvider" in a tray popover takes the whole window with
 * it. Tests also render single components without ceremony because of this.
 */
const fallbackContext: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  dir: directionOf(DEFAULT_LOCALE),
  messages: catalogues[DEFAULT_LOCALE],
  t: (key, vars) => interpolate(catalogues[DEFAULT_LOCALE][key], vars),
  setLocale: () => undefined,
};

const LocaleContext = createContext<LocaleContextValue>(fallbackContext);

export interface LocaleProviderProps {
  /** Controlled locale. Omit to let the provider own it and start from `defaultLocale`. */
  locale?: Locale;
  defaultLocale?: Locale;
  onLocaleChange?: (next: Locale) => void;
  /**
   * Writes `lang` and `dir` onto `<html>`. On by default because scrollbar placement, text
   * selection direction and the native form controls all read from the document element,
   * not from the nearest `dir`. Turn it off only when LocalCast is embedded in a document
   * it does not own.
   */
  applyToDocument?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Provides the catalogue, sets `lang`/`dir` on the document element, and renders the
 * `.lc-root` element that carries the design tokens. Every LocalCast surface mounts inside
 * one of these.
 */
export function LocaleProvider({
  locale: controlled,
  defaultLocale = DEFAULT_LOCALE,
  onLocaleChange,
  applyToDocument = true,
  className,
  children,
}: LocaleProviderProps) {
  const [uncontrolled, setUncontrolled] = useState<Locale>(defaultLocale);
  const locale = controlled ?? uncontrolled;
  const dir = directionOf(locale);

  const setLocale = useCallback(
    (next: Locale) => {
      if (controlled === undefined) setUncontrolled(next);
      onLocaleChange?.(next);
    },
    [controlled, onLocaleChange],
  );

  useEffect(() => {
    if (!applyToDocument || typeof document === 'undefined') return;
    const root = document.documentElement;
    const previousLang = root.lang;
    const previousDir = root.dir;
    root.lang = locale;
    root.dir = dir;
    return () => {
      // Restoring matters in tests and in the Electron window, where several roots mount
      // and unmount over the life of one document.
      root.lang = previousLang;
      root.dir = previousDir;
    };
  }, [applyToDocument, locale, dir]);

  const value = useMemo<LocaleContextValue>(() => {
    const messages = catalogues[locale];
    return {
      locale,
      dir,
      messages,
      t: (key, vars) => interpolate(messages[key], vars),
      setLocale,
    };
  }, [locale, dir, setLocale]);

  return (
    <LocaleContext.Provider value={value}>
      <div className={cx('lc-root', className)} dir={dir} lang={locale}>
        {children}
      </div>
    </LocaleContext.Provider>
  );
}

/** The whole locale context: locale, direction, catalogue, `t`, and the setter. */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** The translate function on its own — the common case. */
export function useT(): TranslateFn {
  return useContext(LocaleContext).t;
}

export type TranslateNodeFn = (key: MessageKey, vars: Readonly<Record<string, ReactNode>>) => ReactNode;

/**
 * `t()` for messages whose placeholder has to be an element rather than a string.
 *
 * The case that forces this: «انقضا تا {time}» where `{time}` is an ASCII duration that must
 * be monospace and LTR-isolated. Concatenating the string and styling the whole sentence
 * would put the Persian words in a monospace face; splitting the sentence by hand around
 * the placeholder would break the moment a translator moves it.
 */
export function useTNode(): TranslateNodeFn {
  const { messages } = useLocale();
  return useCallback(
    (key, vars) => {
      const template = messages[key];
      const parts = template.split(/(\{\w+\})/g);
      return (
        <>
          {parts.map((part, index) => {
            const match = /^\{(\w+)\}$/.exec(part);
            const name = match?.[1];
            const value = name === undefined ? undefined : vars[name];
            return value === undefined ? part : <Fragment key={index}>{value}</Fragment>;
          })}
        </>
      );
    },
    [messages],
  );
}

/**
 * Formatters with the current locale already bound.
 *
 * `bytes`, `duration`, `address` and `code` take no locale on purpose: they are ASCII in
 * every language, and offering a locale parameter would invite someone to pass one.
 */
export interface BoundFormatters {
  count: (value: number) => string;
  percent: (value: number) => string;
  date: (value: number | Date, style?: DateStyle) => string;
  bytes: (value: number) => string;
  duration: (seconds: number) => string;
  address: (host: string, port?: number | null) => string;
  code: (code: string) => string;
}

export function useFormat(): BoundFormatters {
  const { locale } = useLocale();
  return useMemo<BoundFormatters>(
    () => ({
      count: (value) => formatCount(value, locale),
      percent: (value) => formatPercent(value, locale),
      date: (value, style) => formatDate(value, locale, style),
      bytes: formatBytes,
      duration: formatDuration,
      address: formatAddress,
      code: formatCode,
    }),
    [locale],
  );
}

export { fa } from './fa.js';
export { en } from './en.js';
export type { MessageKey, Messages } from './fa.js';
export { DEFAULT_LOCALE, LOCALES, bcp47, directionOf } from './locale.js';
export type { Direction, Locale } from './locale.js';
export {
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
export type { DateStyle } from './format.js';
