import { useCallback } from 'react';
import { useLocale } from '@localcast/ui-kit';
import type { Locale } from '@localcast/ui-kit';

/**
 * Strings this app needs that the shared catalogue does not have.
 *
 * `packages/ui-kit` owns the message catalogue for everything the three surfaces share, and
 * its `MessageKey` union is closed on purpose so an untranslated key is a compile error. The
 * PWA has screens the Windows panel does not — a grid/list toggle, a subtitle picker, a
 * resumable upload — and those strings belong here rather than in a package the panel also
 * imports. Same rules apply: Persian is the source language, no hard-coded digits, and the
 * key union is closed.
 */
export const appFa = {
  // ── library (screen 09) ──────────────────────────────────────────────────────────
  'library.title': 'کتابخانه',
  'library.viewGrid': 'نمای شبکه‌ای',
  'library.viewList': 'نمای فهرستی',
  'library.sort': 'مرتب‌سازی',
  'library.sortName': 'نام',
  'library.sortNewest': 'تازه‌ترین',
  'library.sortLargest': 'بزرگ‌ترین',
  'library.filterContinue': 'ادامه تماشا',
  'library.filter4k': '۴K',
  'library.filterFolders': 'پوشه‌ها',
  'library.root': 'همهٔ پوشه‌ها',
  'library.loadingMore': 'در حال گرفتن ادامه',
  'library.endOfList': 'پایان فهرست',
  'library.foldersEmpty': 'هیچ پوشه‌ای برای این دستگاه باز نیست',
  'library.breadcrumb': 'مسیر پوشه',
  'library.filters': 'صافی‌ها',

  // ── player (screen 10) ───────────────────────────────────────────────────────────
  'player.subtitles': 'زیرنویس',
  'player.subtitlesOff': 'بدون زیرنویس',
  'player.audioTrack': 'باند صدا',
  'player.quality': 'کیفیت',
  'player.qualityUnknown': 'نامشخص',
  'player.airplay': 'پخش روی تلویزیون',
  'player.nativeHint':
    'این فایل را VLC یا Infuse مستقیم باز می‌کند. نشانی WebDAV با رمز همین دستگاه ساخته می‌شود.',
  'player.nativeCopy': 'رونوشت نشانی WebDAV',
  'player.noPosterExplained': 'تا زمانی که استخراج فریم اضافه نشود، پیش‌نمایش ویدیو ساخته نمی‌شود',
  'player.loading': 'در حال آماده‌سازی پخش',
  'player.failed': 'پخش این فایل ممکن نشد',
  'player.back': 'بازگشت به کتابخانه',

  // ── offline (screen 11) ──────────────────────────────────────────────────────────
  'offlineScreen.savedLibrary': 'کتابخانهٔ ذخیره‌شده',
  'offlineScreen.retryIn': 'تلاش بعدی تا {seconds} ثانیه',
  'offlineScreen.retryNow': 'همین حالا تلاش کن',
  'offlineScreen.nothingSaved': 'چیزی برای نمایش آفلاین ذخیره نشده است',
  'offlineScreen.nothingSavedHint': 'وقتی دوباره وصل شدید، فهرست پوشه‌ها برای حالت آفلاین ذخیره می‌شود',
  'offlineScreen.connectedAgain': 'ارتباط دوباره برقرار شد',

  // ── servers and settings (screens 15 and 16) ─────────────────────────────────────
  'servers.title': 'سرورها',
  'servers.thisServer': 'سرور جفت‌شده',
  'servers.advanced': 'تنظیمات پیشرفته',
  'servers.unpair': 'جدا کردن این دستگاه',
  'servers.unpairConfirm': 'دسترسی این گوشی به سرور بسته می‌شود و باید دوباره جفت شود.',
  'servers.davPassword': 'رمز WebDAV این دستگاه',
  'servers.deviceName': 'نام دستگاه',
  'servers.notPaired': 'این گوشی به هیچ سروری جفت نشده است',
  'servers.pairNow': 'جفت‌شدن با سرور',
  'servers.networkReadOnly':
    'این تنظیمات را فقط از برنامهٔ ویندوز می‌شود ذخیره کرد؛ اینجا وضعیت فعلی نشان داده می‌شود.',

  // ── enable remote access (screen 16) ─────────────────────────────────────────────
  'remote.title': 'دسترسی از راه دور',
  'remote.body': 'برای دیدن کتابخانه از بیرون خانه، یک بار وارد شوید. بعد از آن چیزی لازم نیست.',
  'remote.action': 'فعال‌سازی با یک لمس',
  'remote.pending': 'در انتظار ورود روی ویندوز',
  'remote.done': 'دسترسی از راه دور فعال است',
  'remote.loginRequired': 'سرور منتظر ورود شماست',

  // ── printing ─────────────────────────────────────────────────────────────────────
  'printDialog.title': 'چاپ فایل',
  'printDialog.file': 'فایل',
  'printDialog.sent': 'به صف چاپ رفت',
  'printDialog.noPrinters': 'چاپگری در دسترس نیست',
  'printDialog.jobStatus': 'وضعیت کار چاپ',

  // ── uploads (surface 4) ──────────────────────────────────────────────────────────
  'uploads.destination': 'پوشهٔ مقصد',
  'uploads.noWritableFolder': 'هیچ پوشهٔ قابل نوشتنی برای این دستگاه باز نیست',
  'uploads.explain':
    'فایل‌ها به سرور ویندوز فرستاده می‌شوند و از همان‌جا برای بقیهٔ دستگاه‌ها دیده می‌شوند. گوشی خودش میزبان نمی‌شود.',
  'uploads.resume': 'ادامهٔ ارسال',
  'uploads.resumed': 'ارسال از جایی که قطع شده بود ادامه یافت',
  'uploads.queue': 'صف ارسال',
  'uploads.pick': 'انتخاب عکس یا ویدیو',
  'uploads.failed': 'ارسال ناتمام ماند',

  // ── pairing (screen 08) ──────────────────────────────────────────────────────────
  'pair.title': 'جفت‌شدن با سرور',
  'pair.cameraUnavailable': 'دوربین در این حالت در دسترس نیست',
  'pair.cameraHint': 'کد QR را روی صفحهٔ ویندوز نگه دارید تا داخل کادر بیفتد',
  'pair.manualTitle': 'کد ۴ رقمی',
  'pair.manualHint': 'کد را از صفحهٔ «پیرینگ QR» روی ویندوز بخوانید',
  'pair.manualHost': 'نشانی سرور',
  'pair.manualHostHint': 'همان نامی که زیر کد QR نوشته شده است',
  'pair.useCamera': 'برگشت به دوربین',
  'pair.claiming': 'در حال معرفی این دستگاه',
  'pair.waiting': 'روی ویندوز این دستگاه را تأیید کنید',
  'pair.paired': 'جفت شد',
  'pair.invalid': 'این کد پذیرفته نشد',
  'pair.deviceNameDefault': 'آیفون',

  // ── shared ───────────────────────────────────────────────────────────────────────
  'app.reconnecting': 'در حال تلاش برای اتصال دوباره',
  'app.staleData': 'داده‌های ذخیره‌شده',
} as const;

export type AppMessageKey = keyof typeof appFa;
export type AppMessages = { readonly [K in AppMessageKey]: string };

export const appEn: AppMessages = {
  'library.title': 'Library',
  'library.viewGrid': 'Grid view',
  'library.viewList': 'List view',
  'library.sort': 'Sort',
  'library.sortName': 'Name',
  'library.sortNewest': 'Newest',
  'library.sortLargest': 'Largest',
  'library.filterContinue': 'Continue watching',
  'library.filter4k': '4K',
  'library.filterFolders': 'Folders',
  'library.root': 'All folders',
  'library.loadingMore': 'Loading more',
  'library.endOfList': 'End of list',
  'library.foldersEmpty': 'No folder is open to this device',
  'library.breadcrumb': 'Folder path',
  'library.filters': 'Filters',

  'player.subtitles': 'Subtitles',
  'player.subtitlesOff': 'Off',
  'player.audioTrack': 'Audio track',
  'player.quality': 'Quality',
  'player.qualityUnknown': 'Unknown',
  'player.airplay': 'Play on TV',
  'player.nativeHint':
    'VLC and Infuse open this file directly. The WebDAV address is built with this device’s own password.',
  'player.nativeCopy': 'Copy the WebDAV address',
  'player.noPosterExplained': 'Poster frames need frame extraction, which is not shipped yet',
  'player.loading': 'Preparing playback',
  'player.failed': 'This file could not be played',
  'player.back': 'Back to the library',

  'offlineScreen.savedLibrary': 'Saved library',
  'offlineScreen.retryIn': 'Next attempt in {seconds}s',
  'offlineScreen.retryNow': 'Retry now',
  'offlineScreen.nothingSaved': 'Nothing has been saved for offline use',
  'offlineScreen.nothingSavedHint': 'The folder list is saved for offline use once you reconnect',
  'offlineScreen.connectedAgain': 'Connected again',

  'servers.title': 'Servers',
  'servers.thisServer': 'Paired server',
  'servers.advanced': 'Advanced settings',
  'servers.unpair': 'Unpair this device',
  'servers.unpairConfirm': 'This phone loses access to the server and has to be paired again.',
  'servers.davPassword': 'This device’s WebDAV password',
  'servers.deviceName': 'Device name',
  'servers.notPaired': 'This phone is not paired with a server',
  'servers.pairNow': 'Pair with a server',
  'servers.networkReadOnly':
    'These settings can only be saved from the Windows app; this screen shows the current state.',

  'remote.title': 'Remote access',
  'remote.body': 'Sign in once to reach your library from outside the house. Nothing else is needed.',
  'remote.action': 'Enable with one tap',
  'remote.pending': 'Waiting for the sign-in on Windows',
  'remote.done': 'Remote access is on',
  'remote.loginRequired': 'The server is waiting for you to sign in',

  'printDialog.title': 'Print file',
  'printDialog.file': 'File',
  'printDialog.sent': 'Sent to the print queue',
  'printDialog.noPrinters': 'No printer is available',
  'printDialog.jobStatus': 'Print job status',

  'uploads.destination': 'Destination folder',
  'uploads.noWritableFolder': 'No writable folder is open to this device',
  'uploads.explain':
    'Files are pushed to the Windows server and served from there to every other device. The phone never hosts.',
  'uploads.resume': 'Resume',
  'uploads.resumed': 'Resumed from where it stopped',
  'uploads.queue': 'Upload queue',
  'uploads.pick': 'Choose photos or videos',
  'uploads.failed': 'The upload did not finish',

  'pair.title': 'Pair with a server',
  'pair.cameraUnavailable': 'The camera is not available here',
  'pair.cameraHint': 'Hold the QR code on the Windows screen inside the frame',
  'pair.manualTitle': '4-character code',
  'pair.manualHint': 'Read the code from the QR pairing screen on Windows',
  'pair.manualHost': 'Server address',
  'pair.manualHostHint': 'The name printed under the QR code',
  'pair.useCamera': 'Back to the camera',
  'pair.claiming': 'Introducing this device',
  'pair.waiting': 'Approve this device on Windows',
  'pair.paired': 'Paired',
  'pair.invalid': 'That code was not accepted',
  'pair.deviceNameDefault': 'iPhone',

  'app.reconnecting': 'Trying to reconnect',
  'app.staleData': 'Saved data',
};

const appCatalogues: Record<Locale, AppMessages> = { fa: appFa, en: appEn };

export type AppVars = Readonly<Record<string, string | number>>;

function interpolate(template: string, vars?: AppVars): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export type AppTranslateFn = (key: AppMessageKey, vars?: AppVars) => string;

/**
 * The app-local translate function, bound to whatever locale the shared provider is in.
 *
 * Kept separate from `ui-kit`'s `useT` rather than merged into one hook: two closed unions
 * type-check, while a merged `string`-keyed function is exactly the escape hatch through
 * which an untranslated key reaches a Persian screen.
 */
export function useAppT(): AppTranslateFn {
  const { locale } = useLocale();
  return useCallback<AppTranslateFn>(
    (key, vars) => interpolate(appCatalogues[locale][key], vars),
    [locale],
  );
}
