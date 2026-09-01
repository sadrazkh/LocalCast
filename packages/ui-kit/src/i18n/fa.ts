/**
 * Persian catalogue. This is the source of truth for the key set: `Messages` is derived
 * from it, so `en.ts` cannot compile with a key missing or a key that does not exist here.
 *
 * The strings are taken from the design canvas wherever the canvas has one. Where it does
 * not, the wording follows the same register — terse, operator-facing, no exclamation
 * marks. Persian is the primary language of this product; English is a translation of it,
 * not the other way round.
 *
 * Placeholders are `{name}` and are substituted by `t()`.
 *
 * Note on digits: no message here contains a hard-coded Persian digit. Numbers are
 * injected by the `format*` helpers, which decide Persian-vs-ASCII per the rule in
 * docs/design-tokens.md. The one exception is `print.pageRangePlaceholder`, which shows
 * literal syntax the user must type and therefore must stay ASCII.
 */
export const fa = {
  // ── app ──────────────────────────────────────────────────────────────────────────
  'app.name': 'LocalCast',

  // ── common ───────────────────────────────────────────────────────────────────────
  'common.save': 'ذخیره',
  'common.cancel': 'انصراف',
  'common.close': 'بستن',
  'common.confirm': 'تأیید',
  'common.delete': 'حذف',
  'common.edit': 'ویرایش',
  'common.add': 'افزودن',
  'common.remove': 'برداشتن',
  'common.retry': 'تلاش دوباره',
  'common.loading': 'در حال بارگذاری',
  'common.search': 'جست‌وجو',
  'common.back': 'بازگشت',
  'common.next': 'بعدی',
  'common.previous': 'قبلی',
  'common.more': 'بیشتر',
  'common.copy': 'رونوشت',
  'common.copied': 'رونوشت شد',
  'common.yes': 'بله',
  'common.no': 'خیر',
  'common.none': 'هیچ‌کدام',
  'common.all': 'همه',
  'common.unknown': 'نامشخص',
  'common.optional': 'اختیاری',
  'common.required': 'الزامی',
  'common.select': 'انتخاب کنید',
  'common.dismiss': 'بستن',
  'common.refresh': 'تازه‌سازی',

  // ── navigation: the panel rail and the mobile bottom bar ─────────────────────────
  'nav.sharedFolders': 'پوشه‌های اشتراکی',
  'nav.devices': 'دستگاه‌ها',
  'nav.qrPairing': 'پیرینگ QR',
  'nav.activity': 'فعالیت',
  'nav.settings': 'تنظیمات',
  'nav.printers': 'چاپگرها',
  'nav.library': 'کتابخانه',
  'nav.search': 'جست‌وجو',
  'nav.offline': 'آفلاین',
  'nav.servers': 'سرورها',
  'nav.primary': 'ناوبری اصلی',

  // ── connection ───────────────────────────────────────────────────────────────────
  'connection.connected': 'متصل',
  'connection.disconnected': 'قطع',
  'connection.connecting': 'در حال تلاش',
  'connection.label': 'وضعیت اتصال',

  // ── access modes (screen 02) ─────────────────────────────────────────────────────
  'access.label': 'حالت دسترسی',
  'access.full': 'کامل',
  'access.stream': 'فقط پخش',
  'access.none': 'بسته',
  'access.fullHint': 'فهرست، پخش، دانلود، چاپ و بارگذاری',
  'access.streamHint': 'فهرست و پخش؛ بدون دانلود و چاپ',
  'access.noneHint': 'پوشه اصلاً دیده نمی‌شود',

  // ── permission matrix ────────────────────────────────────────────────────────────
  'permissions.title': 'دسترسی دستگاه‌ها',
  'permissions.deviceColumn': 'دستگاه',
  'permissions.cellLabel': 'دسترسی {device} به {folder}',
  'permissions.empty': 'هنوز دستگاهی جفت نشده است',

  // ── devices ──────────────────────────────────────────────────────────────────────
  'devices.title': 'دستگاه‌ها',
  'devices.addNew': 'افزودن دستگاه جدید',
  'devices.approve': 'تأیید',
  'devices.reject': 'رد',
  'devices.revoke': 'بستن دسترسی',
  'devices.pending': 'در انتظار تأیید',
  'devices.active': 'فعال',
  'devices.revoked': 'بسته‌شده',
  'devices.lastSeen': 'آخرین بازدید',
  'devices.neverSeen': 'هرگز',
  'devices.pairingCode': 'کد پیرینگ',
  'devices.empty': 'هیچ دستگاهی جفت نشده است',
  'devices.emptyHint': 'کد QR را با دوربین گوشی اسکن کنید',
  'devices.platform.ios-pwa': 'آیفون',
  'devices.platform.android-pwa': 'اندروید',
  'devices.platform.windows': 'ویندوز',
  'devices.platform.web': 'مرورگر',
  'devices.platform.webdav': 'WebDAV',

  // ── folders ──────────────────────────────────────────────────────────────────────
  'folders.title': 'پوشه‌های اشتراکی',
  'folders.add': 'افزودن پوشه',
  'folders.unavailable': 'در دسترس نیست',
  'folders.writable': 'قابل نوشتن',
  'folders.lastIndexed': 'آخرین نمایه‌سازی',
  'folders.empty': 'هنوز پوشه‌ای به اشتراک گذاشته نشده است',
  'folders.kind.video': 'ویدیو',
  'folders.kind.documents': 'اسناد',
  'folders.kind.photos': 'عکس',
  'folders.kind.mixed': 'ترکیبی',

  // ── files ────────────────────────────────────────────────────────────────────────
  'files.name': 'نام',
  'files.size': 'اندازه',
  'files.date': 'تاریخ',
  'files.kind': 'نوع',
  'files.play': 'پخش',
  'files.download': 'دانلود',
  'files.print': 'چاپ',
  'files.openInNativePlayer': 'باز در پلیر بومی',
  'files.notPlayable': 'این فایل در مرورگر پخش نمی‌شود',
  'files.noPoster': 'پیش‌نمایش ندارد',
  'files.empty': 'این پوشه خالی است',
  'files.folder': 'پوشه',
  'files.kind.video': 'ویدیو',
  'files.kind.audio': 'صدا',
  'files.kind.image': 'عکس',
  'files.kind.document': 'سند',
  'files.kind.archive': 'بایگانی',
  'files.kind.other': 'دیگر',

  // ── printing ─────────────────────────────────────────────────────────────────────
  'print.title': 'چاپ',
  'print.printer': 'چاپگر',
  'print.choosePrinter': 'چاپگر را انتخاب کنید',
  'print.copies': 'تعداد نسخه',
  'print.color': 'رنگ',
  'print.colorColor': 'رنگی',
  'print.colorMono': 'سیاه‌وسفید',
  'print.duplex': 'دورو',
  'print.duplexSimplex': 'یک‌رو',
  'print.duplexLong': 'دورو، لبهٔ بلند',
  'print.duplexShort': 'دورو، لبهٔ کوتاه',
  'print.pageRange': 'محدودهٔ صفحات',
  'print.pageRangePlaceholder': '1-4,7',
  'print.pageRangeHint': 'خالی یعنی همهٔ صفحات',
  'print.submit': 'ارسال به چاپ',
  'print.printerOffline': 'خاموش یا در دسترس نیست',
  'print.printerDefault': 'پیش‌فرض',
  'print.status.queued': 'در صف',
  'print.status.printing': 'در حال چاپ',
  'print.status.done': 'انجام‌شده',
  'print.status.error': 'خطا',
  'print.status.cancelled': 'لغو شد',
  'print.jobsEmpty': 'کاری در صف نیست',
  'print.unprintable': 'این نوع فایل چاپ نمی‌شود؛ فقط PDF و عکس',

  // ── pairing (screen 03) ──────────────────────────────────────────────────────────
  'pairing.title': 'پیرینگ QR',
  'pairing.scanPrompt': 'کد را با دوربین گوشی اسکن کنید',
  'pairing.viewfinderLabel': 'منظره‌یاب دوربین',
  'pairing.codeFallback': 'کد ۴ رقمی',
  'pairing.codeFallbackAction': 'به‌جای اسکن، کد ۴ رقمی را وارد کنید',
  'pairing.codeLabel': 'کد پیرینگ',
  'pairing.expiresIn': 'انقضا تا {time}',
  'pairing.expired': 'کد منقضی شد',
  'pairing.regenerate': 'کد تازه',
  'pairing.cameraDenied': 'دسترسی به دوربین داده نشد',

  // ── network coordination server (screens 14 and 15) ──────────────────────────────
  'network.title': 'سرور هماهنگ‌کنندهٔ شبکه',
  'network.modeDefault': 'پیش‌فرض لوکال‌کست',
  'network.modeDefaultHint': 'بدون تنظیم؛ گواهی خودکار صادر می‌شود',
  'network.modeCustom': 'سرور شخصی (Headscale)',
  'network.modeCustomHint': 'کنترل کامل، اما گواهی باید جداگانه تأمین شود',
  'network.controlUrl': 'نشانی سرور کنترل',
  'network.accessKey': 'کلید دسترسی',
  'network.accessKeyHint': 'رمزگذاری‌شده ذخیره می‌شود و هرگز در گزارش‌ها نمی‌آید',
  'network.hostname': 'نام میزبان',
  'network.expose': 'انتشار',
  'network.exposeTailnet': 'فقط داخل شبکه',
  'network.exposeFunnel': 'نشانی عمومی (Funnel)',
  'network.certStrategy': 'تأمین گواهی',
  'network.certControlPlane': 'از سرور کنترل',
  'network.certExternalProxy': 'پروکسی بیرونی (Caddy یا Nginx)',
  'network.certDns01': 'ACME با DNS-01',
  'network.certDomain': 'دامنه',
  'network.dnsProvider': 'ارائه‌دهندهٔ DNS',
  'network.dnsApiToken': 'توکن API',
  'network.test': 'آزمایش اتصال',
  'network.testing': 'در حال آزمایش…',
  'network.save': 'ذخیره و اتصال مجدد',
  'network.restoreDefaults': 'بازگردانی پیش‌فرض',
  'network.status': 'وضعیت',
  'network.saveBlocked': 'تا وقتی آزمایش موفق نشود، ذخیره ممکن نیست',
  'network.serverAddress': 'نشانی سرور',
  'network.publicAddress': 'نشانی عمومی',
  'network.peers': 'دستگاه‌های متصل',
  'network.certExpires': 'انقضای گواهی',
  'network.certUnavailableTitle': 'این سرور کنترل نمی‌تواند خودش گواهی صادر کند',
  'network.certUnavailableBody':
    'Headscale مسیر «‎/machine/set-dns‎» را پیاده‌سازی نکرده است، پس گواهی از راه سرور کنترل به دست نمی‌آید. یکی از دو راه دیگر را انتخاب کنید: پروکسی بیرونی که خودش TLS را پایان می‌دهد، یا ACME با DNS-01 روی دامنه‌ای که در اختیار دارید.',

  // ── edge state, spelled out in the settings panel (never next to the dot) ────────
  'edge.stopped': 'متوقف',
  'edge.starting': 'در حال شروع',
  'edge.login-required': 'ورود لازم است',
  'edge.connecting': 'در حال تلاش',
  'edge.obtaining-certificate': 'در حال گرفتن گواهی',
  'edge.connected': 'متصل',
  'edge.error': 'خطا',

  // ── activity ─────────────────────────────────────────────────────────────────────
  'activity.title': 'فعالیت',
  'activity.empty': 'فعالیتی ثبت نشده است',

  // ── phone upload (surface 4 — the phone pushes, it never hosts) ──────────────────
  'upload.title': 'اشتراک از گوشی',
  'upload.pick': 'انتخاب عکس یا ویدیو',
  'upload.uploading': 'در حال ارسال',
  'upload.complete': 'ارسال شد',
  'upload.aborted': 'لغو شد',

  // ── offline and degradation (spec §8) ────────────────────────────────────────────
  'offline.title': 'ارتباط با سرور برقرار نیست',
  'offline.body': 'کتابخانهٔ ذخیره‌شده نمایش داده می‌شود و تلاش دوباره ادامه دارد',
  'offline.accessClosed': 'دسترسی بسته شد',
  'offline.folderUnavailable': 'درایو این پوشه در دسترس نیست',

  // ── generic surfaces ─────────────────────────────────────────────────────────────
  'table.empty': 'چیزی برای نمایش نیست',
  'stat.label': 'آمار',

  // ── accessibility strings; never visible unless a screen reader asks ─────────────
  'a11y.revealPassword': 'نمایش مقدار',
  'a11y.hidePassword': 'پنهان کردن مقدار',
  'a11y.closeDialog': 'بستن پنجره',
  'a11y.openMenu': 'باز کردن منو',
  'a11y.progress': 'پیشرفت',
  'a11y.busy': 'در حال انجام',
  'a11y.notification': 'اعلان',
} as const;

/** Every catalogue must supply exactly this key set — no more, no fewer. */
export type Messages = { readonly [K in keyof typeof fa]: string };

/** The typed key union. A `t('typo.key')` call is a compile error, not a runtime blank. */
export type MessageKey = keyof typeof fa;
