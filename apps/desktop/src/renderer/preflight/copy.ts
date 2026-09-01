import { useCallback, useMemo } from 'react';
import { useLocale } from '@localcast/ui-kit';
import type { PrerequisiteId, PrerequisiteState, Remedy } from '../../shared/preflight.js';

/**
 * Everything the prerequisites screen says.
 *
 * It lives here rather than in `lib/copy.ts` because that catalogue is shared with the panel
 * and the tray, and this screen is the wizard's alone. The voice is the wizard's voice, and
 * the same rule applies, enforced by a test that scans the rendered text: **nobody meets a
 * word they would have to look up.** The user is told that a piece of the app is not ready
 * and what it costs them — never what a sidecar is, never what it talks to.
 *
 * Paths, commands and digests are the one exception, and they are not copy: they are the
 * fix. They appear verbatim, folded away behind a disclosure, never in a headline.
 */
export const preflightCopy = {
  fa: {
    'preflight.title': 'بخشی از برنامه هنوز آماده نیست',
    'preflight.lede':
      'قبل از شروع، این موارد باید کامل شود. هر کدام دکمه‌ای دارد که کار را همین‌جا انجام می‌دهد.',
    'preflight.recheck': 'دوباره بررسی کن',
    'preflight.checking': 'در حال بررسی…',
    'preflight.checkFailed': 'بررسی انجام نشد',
    'preflight.skipCheck': 'فعلاً بگذر',

    // ── severity ────────────────────────────────────────────────────────────────────
    'preflight.blocking': 'ضروری',
    'preflight.blockingBody': 'تا وقتی این کامل نشود، ادامه ممکن نیست.',
    'preflight.degrading': 'اختیاری',
    'preflight.degradingBody': 'بقیهٔ برنامه کار می‌کند؛ فقط {feature} در دسترس نخواهد بود.',
    'preflight.continueWithout': 'ادامه بدون این',

    // ── states ──────────────────────────────────────────────────────────────────────
    'preflight.state.checking': 'در حال بررسی',
    'preflight.state.ok': 'آماده',
    'preflight.state.missing': 'پیدا نشد',
    'preflight.state.broken': 'هست، ولی کار نمی‌کند',
    'preflight.state.installing': 'در حال آماده‌سازی',

    // ── the searched paths, which are the fix ───────────────────────────────────────
    'preflight.paths': 'جاهایی که گشتیم',
    'preflight.pathsHint':
      'اگر این فایل را دارید، آن را در یکی از این مسیرها بگذارید و بعد «دوباره بررسی کن» را بزنید.',

    // ── remedies ────────────────────────────────────────────────────────────────────
    // The three fallbacks, keyed by `Remedy.kind`…
    'preflight.remedy.download': 'گرفتن و نصب',
    'preflight.remedy.command': 'انجامش بده',
    'preflight.remedy.manual': 'راهنما را باز کن',
    // …and the keys the main process actually sends today.
    'preflight.remedy.build': 'همین‌جا آماده‌اش کن',
    'preflight.remedy.rebuild': 'درستش کن',
    'preflight.remedy.install': 'آماده‌سازی برنامه',
    'preflight.remedy.readDoc': 'راهنما را باز کن',
    'preflight.remedy.instructions': 'راهنما را باز کن',
    'preflight.source': 'از این صفحه گرفته می‌شود',
    'preflight.openSource': 'دیدن صفحهٔ سازنده',
    'preflight.commandTitle': 'این دقیقاً همان چیزی است که اجرا می‌شود',
    'preflight.commandRun': 'اجرا کن',
    'preflight.commandNotYet': 'هنوز چیزی اجرا نشده است.',

    // ── while it happens, and what happened ─────────────────────────────────────────
    'preflight.installing': 'در حال آماده‌سازی…',
    'preflight.installed': '«{name}» آماده شد.',
    'preflight.savedTo': 'در این مسیر گذاشته شد',
    'preflight.failed.network': 'فایل کامل گرفته نشد. یک بار دیگر تلاش کنید.',
    'preflight.failed.write': 'فایل ذخیره نشد؛ شاید جای کافی نباشد یا اجازهٔ نوشتن نداشته باشیم.',
    'preflight.failed.declined': 'کاری انجام نشد.',
    'preflight.failed.unsupported': 'این کار روی این رایانه شدنی نیست.',
    'preflight.failed.generic': 'انجام نشد.',
    'preflight.details': 'جزئیات فنی',

    // ── the digest, which is the whole point of this screen ─────────────────────────
    'preflight.digest.title': 'این فایل را خودمان نمی‌توانیم تأیید کنیم',
    'preflight.digest.body':
      'نشانهٔ این فایل از قبل نزد ما ثبت نشده، پس برنامه به‌تنهایی نمی‌تواند مطمئن شود همانی است که سازنده منتشر کرده.',
    'preflight.digest.computed': 'نشانهٔ فایلی که گرفتیم',
    'preflight.digest.compare':
      'این نشانه را با نشانه‌ای که در صفحهٔ خود سازنده نوشته شده مقایسه کنید.',
    'preflight.digest.openPage': 'صفحهٔ نشانه‌های سازنده',
    'preflight.digest.confirm': 'مقایسه کردم؛ همین را نصب کن',
    'preflight.digest.discard': 'نصب نکن',
    'preflight.digest.discarded': 'نصب نشد. فایل کنار گذاشته شد.',
    'preflight.mismatch.title': 'این فایل همانی نیست که باید باشد',
    'preflight.mismatch.body':
      'نشانهٔ فایلی که گرفتیم با آنچه سازنده اعلام کرده یکی نیست، پس نصبش نمی‌کنیم.',

    // ── the panel banner ────────────────────────────────────────────────────────────
    'preflight.banner.title': '{feature} هنوز در دسترس نیست',
    'preflight.banner.open': 'رفع کنیم',
    'preflight.banner.close': 'فعلاً نه',

    // ── plain-language names, one per prerequisite ──────────────────────────────────
    'preflight.name.netedge': 'دیده شدن این رایانه توسط دستگاه‌های شما',
    'preflight.feature.netedge': 'وصل شدن دستگاه‌ها وقتی بیرون از خانه هستید',
    'preflight.name.print-helper': 'چاپ',
    'preflight.feature.print-helper': 'چاپ کردن از روی گوشی',
    'preflight.name.native-modules': 'بخش داخلی برنامه',
    'preflight.feature.native-modules': 'به خاطر سپردن فهرست فایل‌ها',
    'preflight.name.unknown': 'بخشی از برنامه',
    'preflight.feature.unknown': 'یکی از قابلیت‌ها',
  },

  en: {
    'preflight.title': 'Part of the app is not ready yet',
    'preflight.lede':
      'These need finishing before you start. Each one has a button that does the work right here.',
    'preflight.recheck': 'Check again',
    'preflight.checking': 'Checking…',
    'preflight.checkFailed': 'The check could not run',
    'preflight.skipCheck': 'Carry on for now',

    'preflight.blocking': 'Needed',
    'preflight.blockingBody': 'Until this is done, there is no way forward.',
    'preflight.degrading': 'Optional',
    'preflight.degradingBody': 'The rest of the app works; only {feature} will be unavailable.',
    'preflight.continueWithout': 'Continue without it',

    'preflight.state.checking': 'Checking',
    'preflight.state.ok': 'Ready',
    'preflight.state.missing': 'Not found',
    'preflight.state.broken': 'Present, but unusable',
    'preflight.state.installing': 'Getting it ready',

    'preflight.paths': 'Where we looked',
    'preflight.pathsHint':
      'If you already have this file, put it in one of these places and press “Check again”.',

    'preflight.remedy.download': 'Get it and install',
    'preflight.remedy.command': 'Do it for me',
    'preflight.remedy.manual': 'Open the instructions',
    'preflight.remedy.build': 'Make it ready here',
    'preflight.remedy.rebuild': 'Fix it',
    'preflight.remedy.install': 'Set the app up',
    'preflight.remedy.readDoc': 'Open the instructions',
    'preflight.remedy.instructions': 'Open the instructions',
    'preflight.source': 'It comes from this page',
    'preflight.openSource': 'See the publisher’s page',
    'preflight.commandTitle': 'This is exactly what will run',
    'preflight.commandRun': 'Run it',
    'preflight.commandNotYet': 'Nothing has run yet.',

    'preflight.installing': 'Getting it ready…',
    'preflight.installed': '“{name}” is ready.',
    'preflight.savedTo': 'Put here',
    'preflight.failed.network': 'The file did not arrive in one piece. Try once more.',
    'preflight.failed.write':
      'The file could not be saved; there may be no room, or no permission to write.',
    'preflight.failed.declined': 'Nothing was done.',
    'preflight.failed.unsupported': 'This cannot be done on this computer.',
    'preflight.failed.generic': 'It did not work.',
    'preflight.details': 'Technical detail',

    'preflight.digest.title': 'We cannot vouch for this file ourselves',
    'preflight.digest.body':
      'Nobody recorded this file’s fingerprint for us beforehand, so the app cannot tell on its own whether it is the one the publisher released.',
    'preflight.digest.computed': 'Fingerprint of the file we got',
    'preflight.digest.compare':
      'Compare it against the fingerprint written on the publisher’s own page.',
    'preflight.digest.openPage': 'The publisher’s fingerprint page',
    'preflight.digest.confirm': 'I compared them — install it',
    'preflight.digest.discard': 'Do not install it',
    'preflight.digest.discarded': 'Not installed. The file was thrown away.',
    'preflight.mismatch.title': 'This file is not the one it should be',
    'preflight.mismatch.body':
      'The fingerprint of the file we got does not match the one the publisher announced, so we are not installing it.',

    'preflight.banner.title': '{feature} is still unavailable',
    'preflight.banner.open': 'Let us fix it',
    'preflight.banner.close': 'Not now',

    'preflight.name.netedge': 'Your devices being able to see this computer',
    'preflight.feature.netedge': 'devices connecting while you are away from home',
    'preflight.name.print-helper': 'Printing',
    'preflight.feature.print-helper': 'printing from your phone',
    'preflight.name.native-modules': 'The app’s own inner workings',
    'preflight.feature.native-modules': 'remembering the list of your files',
    'preflight.name.unknown': 'Part of the app',
    'preflight.feature.unknown': 'one of the features',
  },
} as const;

export type PreflightCopyKey = keyof typeof preflightCopy.fa;
export type CopyVars = Readonly<Record<string, string | number>>;

function fill(template: string, vars?: CopyVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export interface PreflightText {
  /** Typed lookup: an untranslated key is a compile error, not a blank on a Persian screen. */
  c(key: PreflightCopyKey, vars?: CopyVars): string;
  /** The plain-language name of a prerequisite. */
  nameOf(id: PrerequisiteId | string): string;
  /** The single feature a `degrading` prerequisite costs, phrased to sit inside a sentence. */
  featureOf(id: PrerequisiteId | string): string;
  stateOf(state: PrerequisiteState): string;
  /** The label on a remedy button. */
  labelOf(remedy: Remedy): string;
}

/**
 * `Remedy.labelKey` is resolved "by the renderer's catalogue" — but the main process picks
 * the keys, and it is being written in parallel with this screen. So an unknown key is not
 * an error and is never rendered raw: it falls back to a label chosen by the remedy's kind,
 * which is always accurate, if less specific. A button reading
 * `preflight.remedy.sumatraPortable` would be a worse bug than a generic one.
 */
export function usePreflightText(): PreflightText {
  const { locale } = useLocale();

  const c = useCallback(
    (key: PreflightCopyKey, vars?: CopyVars) => fill(preflightCopy[locale][key], vars),
    [locale],
  );

  return useMemo<PreflightText>(() => {
    const table: Record<string, string> = preflightCopy[locale];
    const lookup = (key: string): string | undefined => table[key];

    return {
      c,
      nameOf: (id) => lookup(`preflight.name.${id}`) ?? c('preflight.name.unknown'),
      featureOf: (id) => lookup(`preflight.feature.${id}`) ?? c('preflight.feature.unknown'),
      stateOf: (state) => lookup(`preflight.state.${state}`) ?? c('preflight.state.checking'),
      labelOf: (remedy) =>
        lookup(remedy.labelKey) ?? lookup(`preflight.remedy.${remedy.kind}`) ?? c('preflight.remedy.manual'),
    };
  }, [c, locale]);
}
