import { useCallback } from 'react';
import { useLocale } from '@localcast/ui-kit';

/**
 * Strings that belong to the Windows app and to nothing else.
 *
 * The shared catalogue in `@localcast/ui-kit` covers everything three surfaces have in
 * common. The wizard, the tray popover and the operator panel are this app's alone, so their
 * wording lives here rather than being pushed into a package the PWA also imports.
 *
 * The rule the wizard copy is written against, and which a test enforces by scanning the
 * rendered text: **an ordinary user setting this up meets no technical language at all.**
 * No control server, no mesh, no relay, no address, no certificate, no numbered ports. If a
 * sentence here cannot be said to someone who has never configured a network, it is wrong.
 */
export const copy = {
  fa: {
    // ── shell ──────────────────────────────────────────────────────────────────────
    'shell.brand': 'LocalCast',
    'shell.language': 'زبان',
    'shell.languageFa': 'فارسی',
    'shell.languageEn': 'English',
    'shell.address': 'نشانی سرور',
    'shell.addressUnknown': 'هنوز آماده نیست',
    'shell.copyAddress': 'رونوشت نشانی',
    'shell.nav.hosting': 'میزبانی',

    // ── confirmation ───────────────────────────────────────────────────────────────
    'confirm.title': 'مطمئن هستید؟',

    // ── wizard ─────────────────────────────────────────────────────────────────────
    'wizard.step': 'گام {current} از {total}',
    'wizard.folderTitle': 'یک پوشه برای اشتراک انتخاب کنید',
    'wizard.folderBody':
      'هر چیزی که داخل این پوشه باشد روی گوشی و دستگاه‌های دیگر شما دیده می‌شود. بقیهٔ رایانه دست‌نخورده می‌ماند.',
    'wizard.folderChoose': 'انتخاب پوشه',
    'wizard.folderChosen': 'پوشهٔ انتخاب‌شده',
    'wizard.folderLater': 'بعداً تغییر بده',
    'wizard.folderFailed': 'این پوشه اضافه نشد',
    'wizard.signInTitle': 'یک بار وارد شوید',
    'wizard.signInBody':
      'برای اینکه دستگاه‌های شما بتوانند این رایانه را پیدا کنند، یک بار باید وارد شوید. مرورگر همیشگی شما باز می‌شود و بقیه‌اش خودکار انجام می‌گیرد.',
    'wizard.signInAction': 'ورود',
    'wizard.signInAgain': 'دوباره باز کن',
    'wizard.signInWaiting': 'منتظر تکمیل ورود در مرورگر…',
    'wizard.signInReady': 'آماده شد',
    'wizard.signInFailed': 'ورود کامل نشد. یک بار دیگر تلاش کنید.',
    'wizard.qrTitle': 'اولین دستگاه را اضافه کنید',
    'wizard.qrBody': 'با دوربین گوشی این تصویر را بگیرید تا دستگاه شما وصل شود.',
    // Used while remote access is switched off, which is the only time the same-Wi-Fi
    // condition is real. It is a promise, not a warning: no account, nothing to sign into.
    'wizard.qrBodyLocal':
      'گوشی را به همین وای‌فای وصل کنید و با دوربینش این تصویر را بگیرید. هیچ حساب کاربری لازم نیست.',
    'wizard.qrFallback': 'اگر دوربین کار نکرد، این چهار نویسه را دستی وارد کنید',
    'wizard.qrFailed': 'ساختن تصویر انجام نشد',
    'wizard.finish': 'پایان',
    'wizard.later': 'فعلاً رد کن',

    // ── hosting overview ───────────────────────────────────────────────────────────
    'hosting.title': 'میزبانی',
    'hosting.serverOn': 'سرور روشن است',
    'hosting.serverOff': 'سرور خاموش است',
    'hosting.turnOn': 'روشن کردن سرور',
    'hosting.turnOff': 'خاموش کردن سرور',
    'hosting.turnOffConfirm': 'تا وقتی سرور خاموش است هیچ دستگاهی به فایل‌ها دسترسی ندارد.',
    'hosting.signInNeeded': 'برای روشن شدن، یک بار ورود لازم است',
    'hosting.signIn': 'ورود',
    'hosting.devices': 'دستگاه‌های فعال',
    'hosting.folders': 'پوشه‌های اشتراکی',
    'hosting.files': 'فایل‌های نمایه‌شده',
    'hosting.uptime': 'مدت روشن بودن',

    // ── folders (screen 01) ────────────────────────────────────────────────────────
    'folders.path': 'مسیر',
    'folders.share': 'اشتراک',
    'folders.autoIndex': 'نمایه‌سازی خودکار',
    'folders.autoIndexHint': 'تغییرات پوشه بدون دخالت شما به فهرست اضافه می‌شود',
    'folders.rescan': 'پویش دوباره',
    'folders.rescanAll': 'پویش دوبارهٔ همه',
    'folders.remove': 'برداشتن پوشه',
    'folders.removeConfirm':
      'پوشهٔ «{label}» از اشتراک برداشته می‌شود. فایل‌ها روی دیسک دست‌نخورده می‌مانند، اما هیچ دستگاهی دیگر آن‌ها را نمی‌بیند.',
    'folders.dropHere': 'پوشه را اینجا رها کنید',
    'folders.dropHint': 'یا از دکمهٔ افزودن پوشه استفاده کنید',
    'folders.never': 'هرگز',
    'folders.emptyHint': 'یک پوشه اضافه کنید تا دستگاه‌های شما چیزی برای دیدن داشته باشند',

    // ── devices (screen 02) ────────────────────────────────────────────────────────
    'devices.pendingTitle': 'در انتظار تأیید',
    'devices.pendingHint': 'کد روی گوشی را با کد اینجا مقایسه کنید و بعد تأیید بزنید',
    'devices.listTitle': 'دستگاه‌های جفت‌شده',
    'devices.rejectConfirm': 'درخواست «{name}» رد می‌شود و کدش باطل خواهد شد.',
    'devices.revokeConfirm':
      'دسترسی «{name}» بسته می‌شود. اگر همان لحظه در حال پخش باشد، پخش قطع می‌شود و برای برگشتن باید دوباره جفت شود.',
    'devices.statActive': 'دستگاه‌های متصل',
    'devices.statStreams': 'پخش‌های در جریان',
    'devices.statTraffic': 'داده‌های جابه‌جاشده',
    'devices.statWindow': 'در یک ساعت گذشته',
    'devices.statNotMeasured': 'هنوز شمرده نمی‌شود',
    'devices.matrixTitle': 'دسترسی هر دستگاه به هر پوشه',

    // ── pairing (screen 03) ────────────────────────────────────────────────────────
    'pairing.defaultsTitle': 'دسترسی پیش‌فرض دستگاه تازه',
    'pairing.defaultsHint': 'بعد از تأیید می‌توانید برای هر پوشه جداگانه تغییرش دهید',
    'pairing.noFolders': 'هنوز پوشه‌ای برای اشتراک نیست',
    'pairing.minting': 'در حال ساختن کد…',
    'pairing.failed': 'ساختن کد انجام نشد',
    'pairing.lanAddress': 'نشانی روی همین وای‌فای',
    // Said plainly, and said *before* it happens. The phone shows a warning the first time it
    // connects, because the connection is protected by this computer itself rather than by an
    // outside company. Hiding that would mean the user meets a scary screen with no idea why;
    // naming it first turns it into a step they were expecting.
    'pairing.trustOnce':
      'بار اول، گوشی می‌پرسد که آیا به این رایانه اعتماد می‌کنید. «بله» را بزنید؛ همین رایانهٔ خودتان است و فقط یک بار پرسیده می‌شود.',

    // ── settings (screen 14) ───────────────────────────────────────────────────────
    'settings.level.info': 'اطلاع',
    'settings.level.warn': 'هشدار',
    'settings.level.error': 'خطا',
    'settings.storedSecret': 'ذخیره‌شده — برای تغییر مقدار تازه بنویسید',
    'settings.storedSecretPlaceholder': '••••••••••••',
    'settings.testFirst': 'تا وقتی آزمایش موفق نشود، ذخیره ممکن نیست',
    'settings.tested': 'این تنظیمات آزمایش شد و کار می‌کند',
    'settings.saved': 'ذخیره شد',
    'settings.restoreConfirm':
      'تنظیمات شبکه به حالت پیش‌فرض برمی‌گردد و اتصال دوباره برقرار می‌شود. پوشه‌ها، دستگاه‌ها و دسترسی‌ها دست‌نخورده می‌مانند.',
    'settings.proxyWarning':
      'اگر پروکسی بیرونی روی یک سرور اجاره‌ای باشد، همهٔ بایت‌های ویدیو از همان سرور رد می‌شود؛ برای فیلم ۴K این یعنی مصرف پهنای باند اجاره‌ای به‌جای انتقال مستقیم.',

    // ── activity ───────────────────────────────────────────────────────────────────
    'activity.reload': 'تازه‌سازی',
    'activity.unknownDevice': 'بدون دستگاه',
    'act.device.claimed': 'دستگاهی کد را وارد کرد',
    'act.device.approved': 'دستگاه تأیید شد',
    'act.device.rejected': 'دستگاه رد شد',
    'act.device.revoked': 'دسترسی دستگاه بسته شد',
    'act.device.paired': 'دستگاه جفت شد',
    'act.device.deleted': 'دستگاه حذف شد',
    'act.folder.added': 'پوشه اضافه شد',
    'act.folder.removed': 'پوشه برداشته شد',
    'act.folder.updated': 'پوشه تغییر کرد',
    'act.pairing.minted': 'کد تازه ساخته شد',
    'act.permissions.updated': 'دسترسی‌ها تغییر کرد',
    'act.print.queued': 'کار چاپ در صف نشست',
    'act.upload.started': 'ارسال فایل شروع شد',
    'act.upload.completed': 'ارسال فایل تمام شد',
    'act.upload.aborted': 'ارسال فایل لغو شد',
    'act.dav.propfind': 'مرور از راه WebDAV',

    // ── tray (screen 04) ───────────────────────────────────────────────────────────
    'tray.on': 'سرور روشن است',
    'tray.off': 'سرور خاموش است',
    'tray.offBody':
      'دستگاه‌هایی که قبلاً جفت شده‌اند بعد از روشن کردن دوباره خودشان وصل می‌شوند؛ لازم نیست دوباره اسکن کنید.',
    'tray.turnOn': 'روشن کردن سرور',
    'tray.network': 'شبکه',
    'tray.networkDefault': 'پیش‌فرض لوکال‌کست',
    'tray.networkCustom': 'سرور شخصی',
    'tray.uptime': 'روشن از',
    'tray.connected': 'دستگاه‌های متصل',
    'tray.nobody': 'کسی وصل نیست',
    'tray.addDevice': 'افزودن دستگاه',
    'tray.folders': 'پوشه‌های اشتراکی',
    'tray.settings': 'تنظیمات',
    'tray.quit': 'خروج',
    'tray.idle': 'بی‌کار',
    'tray.back': 'بازگشت',
    'tray.menuOnly':
      'تنظیمات و خروج از منوی راست‌کلیک روی نماد سینی انجام می‌شود؛ این پنجرهٔ کوچک راهی برای باز کردن پنل ندارد.',

    // ── what a device is doing, derived from the activity feed ─────────────────────
    'doing.streaming': 'در حال پخش',
    'doing.downloading': 'در حال دانلود',
    'doing.browsing': 'در حال گشتن',
    'doing.printing': 'در حال چاپ',
    'doing.uploading': 'در حال فرستادن فایل',
  },

  en: {
    'shell.brand': 'LocalCast',
    'shell.language': 'Language',
    'shell.languageFa': 'فارسی',
    'shell.languageEn': 'English',
    'shell.address': 'Server address',
    'shell.addressUnknown': 'Not ready yet',
    'shell.copyAddress': 'Copy address',
    'shell.nav.hosting': 'Hosting',

    'confirm.title': 'Are you sure?',

    'wizard.step': 'Step {current} of {total}',
    'wizard.folderTitle': 'Choose a folder to share',
    'wizard.folderBody':
      'Anything inside this folder shows up on your phone and your other devices. The rest of this computer stays private.',
    'wizard.folderChoose': 'Choose a folder',
    'wizard.folderChosen': 'Chosen folder',
    'wizard.folderLater': 'Change it later',
    'wizard.folderFailed': 'That folder could not be added',
    'wizard.signInTitle': 'Sign in once',
    'wizard.signInBody':
      'Sign in once so your devices can find this computer. Your usual browser opens and the rest happens on its own.',
    'wizard.signInAction': 'Sign in',
    'wizard.signInAgain': 'Open it again',
    'wizard.signInWaiting': 'Waiting for you to finish in the browser…',
    'wizard.signInReady': 'Ready',
    'wizard.signInFailed': 'Sign-in did not finish. Try once more.',
    'wizard.qrTitle': 'Add your first device',
    'wizard.qrBody': 'Point your phone camera at this picture to connect it.',
    'wizard.qrBodyLocal':
      'Put your phone on this same Wi-Fi and point its camera at this picture. No account is needed.',
    'wizard.qrFallback': 'If the camera will not do it, type these four characters instead',
    'wizard.qrFailed': 'The picture could not be made',
    'wizard.finish': 'Finish',
    'wizard.later': 'Skip for now',

    'hosting.title': 'Hosting',
    'hosting.serverOn': 'Server is on',
    'hosting.serverOff': 'Server is off',
    'hosting.turnOn': 'Turn the server on',
    'hosting.turnOff': 'Turn the server off',
    'hosting.turnOffConfirm': 'While the server is off, no device can reach your files.',
    'hosting.signInNeeded': 'Signing in once is needed before it can start',
    'hosting.signIn': 'Sign in',
    'hosting.devices': 'Active devices',
    'hosting.folders': 'Shared folders',
    'hosting.files': 'Indexed files',
    'hosting.uptime': 'Running for',

    'folders.path': 'Path',
    'folders.share': 'Shared',
    'folders.autoIndex': 'Automatic indexing',
    'folders.autoIndexHint': 'Changes in the folder are picked up without you asking',
    'folders.rescan': 'Re-scan',
    'folders.rescanAll': 'Re-scan everything',
    'folders.remove': 'Remove folder',
    'folders.removeConfirm':
      '“{label}” stops being shared. The files stay on disk untouched, but no device will see them any more.',
    'folders.dropHere': 'Drop a folder here',
    'folders.dropHint': 'or use the add-folder button',
    'folders.never': 'Never',
    'folders.emptyHint': 'Add a folder so your devices have something to look at',

    'devices.pendingTitle': 'Waiting for approval',
    'devices.pendingHint': 'Check the code on the phone against the code here, then approve',
    'devices.listTitle': 'Paired devices',
    'devices.rejectConfirm': '“{name}” is turned away and its code stops working.',
    'devices.revokeConfirm':
      '“{name}” loses access. Anything it is playing right now stops, and it has to pair again to come back.',
    'devices.statActive': 'Connected devices',
    'devices.statStreams': 'Streams in flight',
    'devices.statTraffic': 'Data moved',
    'devices.statWindow': 'in the last hour',
    'devices.statNotMeasured': 'Not counted yet',
    'devices.matrixTitle': 'Which device may reach which folder',

    'pairing.defaultsTitle': 'Default access for the new device',
    'pairing.defaultsHint': 'You can change it per folder after you approve',
    'pairing.noFolders': 'No folder is shared yet',
    'pairing.minting': 'Making a code…',
    'pairing.failed': 'The code could not be made',
    'pairing.lanAddress': 'Address on this Wi-Fi',
    'pairing.trustOnce':
      'The first time it connects, your phone will ask whether to trust this computer. Say yes — it means this computer, and it only asks once.',

    'settings.level.info': 'Note',
    'settings.level.warn': 'Warning',
    'settings.level.error': 'Error',
    'settings.storedSecret': 'Stored — type a new value to replace it',
    'settings.storedSecretPlaceholder': '••••••••••••',
    'settings.testFirst': 'Saving is blocked until a test succeeds',
    'settings.tested': 'These settings were tested and work',
    'settings.saved': 'Saved',
    'settings.restoreConfirm':
      'Network settings go back to the defaults and the connection is re-established. Folders, devices and permissions are untouched.',
    'settings.proxyWarning':
      'If the external proxy lives on a rented server, every video byte is relayed through it — for a 4K film that is a rented uplink instead of a direct transfer.',

    'activity.reload': 'Refresh',
    'activity.unknownDevice': 'No device',
    'act.device.claimed': 'A device entered the code',
    'act.device.approved': 'Device approved',
    'act.device.rejected': 'Device turned away',
    'act.device.revoked': 'Device access closed',
    'act.device.paired': 'Device paired',
    'act.device.deleted': 'Device deleted',
    'act.folder.added': 'Folder added',
    'act.folder.removed': 'Folder removed',
    'act.folder.updated': 'Folder changed',
    'act.pairing.minted': 'A new code was made',
    'act.permissions.updated': 'Permissions changed',
    'act.print.queued': 'Print job queued',
    'act.upload.started': 'Upload started',
    'act.upload.completed': 'Upload finished',
    'act.upload.aborted': 'Upload cancelled',
    'act.dav.propfind': 'Browsed over WebDAV',

    'tray.on': 'Server is on',
    'tray.off': 'Server is off',
    'tray.offBody':
      'Devices you have already paired reconnect on their own once it is back on — there is nothing to scan again.',
    'tray.turnOn': 'Turn the server on',
    'tray.network': 'Network',
    'tray.networkDefault': 'LocalCast default',
    'tray.networkCustom': 'Personal server',
    'tray.uptime': 'On since',
    'tray.connected': 'Connected devices',
    'tray.nobody': 'Nobody is connected',
    'tray.addDevice': 'Add a device',
    'tray.folders': 'Shared folders',
    'tray.settings': 'Settings',
    'tray.quit': 'Quit',
    'tray.idle': 'Idle',
    'tray.back': 'Back',
    'tray.menuOnly':
      'Settings and Quit live on the tray icon’s right-click menu; this small window has no way to open the panel.',

    'doing.streaming': 'Playing',
    'doing.downloading': 'Downloading',
    'doing.browsing': 'Browsing',
    'doing.printing': 'Printing',
    'doing.uploading': 'Sending a file',
  },
} as const;

export type CopyKey = keyof typeof copy.fa;
export type CopyVars = Readonly<Record<string, string | number>>;
export type CopyFn = (key: CopyKey, vars?: CopyVars) => string;

/**
 * The app-local twin of `useT`. Same contract: a typed key union, `{name}` placeholders, and
 * no `string` overload — an untranslated key is a compile error rather than a blank on a
 * Persian screen.
 */
export function useCopy(): CopyFn {
  const { locale } = useLocale();
  return useCallback(
    (key: CopyKey, vars?: CopyVars) => {
      const template: string = copy[locale][key];
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = vars[name];
        return value === undefined ? match : String(value);
      });
    },
    [locale],
  );
}
