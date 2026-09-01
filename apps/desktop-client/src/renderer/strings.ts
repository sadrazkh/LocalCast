/**
 * Persian strings this app needs and `@localcast/ui-kit`'s catalogue does not carry.
 *
 * The kit's `t()` takes a typed key union derived from its own catalogue, which is exactly
 * what stops a typo becoming a blank label — and equally what stops this app inventing keys
 * inside it. Rather than editing a package another surface shares, the client-specific
 * wording lives here, in the same register the canvas uses: terse, no exclamation marks,
 * Persian first.
 *
 * Anything the kit *does* have — «متصل», «دانلود», «باز در پلیر بومی», the access-mode
 * labels — is taken from `useT()` and is deliberately absent below, so the two never drift.
 */
export const S = {
  // ── screen 05: find servers ───────────────────────────────────────────────
  serversTitle: 'سرورها',
  serversSubtitle: 'سرورهایی که این رایانه با آنها جفت شده است',
  serversEmpty: 'هنوز سروری اضافه نشده است',
  serversEmptyHint: 'نشانی سرور را وارد کنید، سپس با کد چهار نویسه‌ای جفت شوید',
  addByAddress: 'افزودن با IP',
  pairWithCode: 'ورود با کد',
  connect: 'اتصال',
  openLibrary: 'کتابخانه',
  forget: 'فراموش کردن',
  removeServer: 'حذف از فهرست',
  statePaired: 'جفت‌شده',
  stateNeedsPairing: 'نیاز به جفت‌سازی',
  stateOffline: 'خاموش',
  lastConnected: 'آخرین اتصال',
  neverConnected: 'هرگز',

  addDialogTitle: 'افزودن سرور',
  addDialogHostLabel: 'نشانی سرور',
  addDialogHostHint:
    'نام میزبان MagicDNS سرور، مثل ali-pc.tail1234.ts.net. نشانی عددی پذیرفته نمی‌شود، چون برای آن گواهی معتبر صادر نمی‌شود.',
  addDialogLabelLabel: 'نامی که برای شما آشناست',
  addDialogInvalidHost: 'این نشانی برای لوکال‌کست قابل استفاده نیست',
  addDialogSubmit: 'افزودن',

  pairDialogTitle: 'ورود با کد',
  pairDialogBody: 'کد چهار نویسه‌ای را که روی پنل آن رایانه نمایش داده می‌شود وارد کنید',
  pairDialogCodeLabel: 'کد پیرینگ',
  pairDialogWaiting: 'در انتظار تأیید اپراتور…',
  pairDialogSubmit: 'ارسال',
  pairDialogDeviceName: 'این رایانه با نام «{name}» معرفی می‌شود',

  // ── screen 06: library and transfers ──────────────────────────────────────
  libraryTitle: 'کتابخانه',
  backToServers: 'بازگشت به سرورها',
  foldersHeading: 'پوشه‌ها',
  searchPlaceholder: 'جست‌وجو در این سرور',
  sortLabel: 'ترتیب',
  sortName: 'نام',
  sortSize: 'اندازه',
  sortDate: 'تاریخ',
  viewGrid: 'نمای پوستری',
  viewTable: 'نمای جدول',
  actionsColumn: 'کارها',
  upOneLevel: 'یک سطح بالاتر',
  searchResults: 'نتیجهٔ جست‌وجو',
  uploadToFolder: 'بارگذاری در این پوشه',
  uploadNotWritable: 'این پوشه فقط خواندنی است',
  downloadNotAllowed: 'در حالت «فقط پخش» دانلود ممکن نیست',

  transfersTitle: 'انتقال‌ها',
  transfersEmpty: 'انتقالی در جریان نیست',
  transfersSavedTo: 'محل ذخیره',
  transferPause: 'توقف',
  transferResume: 'ادامه',
  transferCancel: 'لغو',
  transferReveal: 'نمایش در پوشه',
  transferQueued: 'در صف',
  transferDownloading: 'در حال دریافت',
  transferPaused: 'متوقف',
  transferDone: 'انجام‌شده',
  transferError: 'خطا',
  transferCancelled: 'لغو شد',
  transferUploading: 'در حال ارسال',

  // ── screen 07: the player ─────────────────────────────────────────────────
  playerBack: 'بازگشت به کتابخانه',
  playerPlay: 'پخش',
  playerPause: 'مکث',
  playerMute: 'بی‌صدا',
  playerUnmute: 'باصدا',
  playerSeek: 'موقعیت پخش',
  playerVolume: 'بلندی صدا',
  playerSubtitles: 'زیرنویس',
  playerAudioTrack: 'صدا',
  playerNoSubtitles: 'بدون زیرنویس',
  playerTracksUnavailable: 'مسیر دیگری در این فایل نیست',
  playerStatusHeading: 'چه اتفاقی می‌افتد',
  playerStatusIdle: 'آمادهٔ پخش',
  playerStatusLoading: 'در حال گرفتن نخستین بایت‌ها',
  playerStatusBuffering: 'در حال پرکردن بافر',
  playerStatusPlaying: 'در حال پخش',
  playerStatusPaused: 'مکث',
  playerStatusEnded: 'پایان فایل',
  playerStatusError: 'پخش این فایل در همین پنجره ممکن نشد',
  playerCopyLink: 'رونوشت نشانی برای پلیر بومی',
  playerHandoffTitle: 'این فایل در این پنجره پخش نمی‌شود',
  playerHandoffBody:
    'این نسخه بدون ffmpeg منتشر شده و ظرف یا صدای این فایل را باز نمی‌کند. نشانی WebDAV را در VLC یا Infuse باز کنید؛ همان فایل، بدون تبدیل.',
  playerBrowserPlayableButFailed:
    'سرور این فایل را قابل پخش اعلام کرده بود، اما موتور پخش آن را باز نکرد. نشانی بومی همچنان کار می‌کند.',

  // ── shared ────────────────────────────────────────────────────────────────
  errorTitle: 'کار انجام نشد',
  notPaired: 'این رایانه هنوز با این سرور جفت نشده است',
} as const;

/** `{name}` substitution for the two strings above that carry one. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * Prose for the stable error codes this app can actually surface.
 *
 * Keyed by `ErrorCode` from the contract, never by matching on the server's message: that
 * prose is already localised server-side and may be reworded at any time.
 */
export const ERROR_TEXT: Record<string, string> = {
  pairing_invalid: 'این کد پذیرفته نشد',
  pairing_expired: 'کد منقضی شده است؛ از اپراتور کد تازه بخواهید',
  pairing_consumed: 'این کد پیش‌تر استفاده شده است',
  pairing_locked: 'به دلیل تلاش‌های ناموفق، این کد قفل شد',
  rate_limited: 'درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید',
  unauthenticated: 'دسترسی این رایانه معتبر نیست',
  token_revoked: 'دسترسی بسته شد',
  device_revoked: 'دسترسی بسته شد',
  device_pending: 'هنوز تأیید نشده است',
  forbidden: 'اجازهٔ این کار داده نشده است',
  download_not_allowed: 'در حالت «فقط پخش» دانلود ممکن نیست',
  upload_not_allowed: 'بارگذاری در این پوشه مجاز نیست',
  folder_unavailable: 'درایو این پوشه در دسترس نیست',
  not_found: 'این مورد پیدا نشد',
  edge_not_ready: 'سرور هنوز آمادهٔ پاسخ نیست',
  edge_login_required: 'اپراتور باید در آن رایانه وارد شود',
  range_not_satisfiable: 'نسخهٔ روی سرور با نسخهٔ ناتمام این رایانه یکی نیست',
  internal: 'خطای غیرمنتظره',
};

export function errorText(code: string | null | undefined): string {
  if (!code) return ERROR_TEXT.internal ?? S.errorTitle;
  return ERROR_TEXT[code] ?? ERROR_TEXT.internal ?? S.errorTitle;
}
