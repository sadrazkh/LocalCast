import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { EdgeStatus } from '@localcast/contract';
import { positionTrayWindow } from './windows.js';

/**
 * The tray icon and its popover (screen 04 of the design canvas).
 *
 * The icon carries one bit — is the server reachable — and the tooltip carries the address.
 * Deliberately no transport detail anywhere: the product promise is that the user never
 * learns what a relay or a MagicDNS name is unless they go looking.
 */

const LABELS = {
  fa: {
    running: 'سرور روشن است',
    stopped: 'سرور خاموش است',
    connecting: 'در حال اتصال…',
    loginRequired: 'ورود لازم است',
    error: 'خطا در اتصال',
    open: 'باز کردن پنل',
    addDevice: 'افزودن دستگاه…',
    folders: 'پوشه‌های اشتراکی',
    settings: 'تنظیمات',
    quit: 'خروج و توقف سرور',
  },
  en: {
    running: 'Server is on',
    stopped: 'Server is off',
    connecting: 'Connecting…',
    loginRequired: 'Sign-in needed',
    error: 'Connection error',
    open: 'Open panel',
    addDevice: 'Add a device…',
    folders: 'Shared folders',
    settings: 'Settings',
    quit: 'Quit and stop the server',
  },
} as const;

export interface TrayCallbacks {
  onOpenPanel(): void;
  onAddDevice(): void;
  onFolders(): void;
  onSettings(): void;
  onQuit(): void;
}

export class AppTray {
  #tray: Tray;
  #locale: 'fa' | 'en';

  constructor(
    private readonly assetsDir: string,
    private readonly popover: BrowserWindow,
    private readonly callbacks: TrayCallbacks,
    locale: 'fa' | 'en' = 'fa',
  ) {
    this.#locale = locale;
    this.#tray = new Tray(this.#icon(false));
    this.#tray.setToolTip('LocalCast');

    // Left click toggles the popover; right click gets the menu, because a popover that
    // appears on right click is not what a Windows user expects from a tray icon.
    this.#tray.on('click', () => this.togglePopover());
    this.#tray.on('right-click', () => this.#tray.popUpContextMenu(this.#menu()));
  }

  #icon(active: boolean) {
    const name = active ? 'tray-32.png' : 'tray-32-off.png';
    const image = nativeImage.createFromPath(join(this.assetsDir, 'icons', name));
    // Without this the 32px asset is drawn at 32 logical pixels and swamps the tray.
    image.setTemplateImage(false);
    return image.resize({ width: 16, height: 16 });
  }

  #menu(): Menu {
    const t = LABELS[this.#locale];
    return Menu.buildFromTemplate([
      { label: t.open, click: () => this.callbacks.onOpenPanel() },
      { label: t.addDevice, click: () => this.callbacks.onAddDevice() },
      { type: 'separator' },
      { label: t.folders, click: () => this.callbacks.onFolders() },
      { label: t.settings, click: () => this.callbacks.onSettings() },
      { type: 'separator' },
      { label: t.quit, click: () => this.callbacks.onQuit() },
    ]);
  }

  togglePopover(): void {
    if (this.popover.isVisible()) {
      this.popover.hide();
      return;
    }
    positionTrayWindow(this.popover, this.#tray.getBounds());
    this.popover.show();
    this.popover.focus();
  }

  update(status: EdgeStatus): void {
    const t = LABELS[this.#locale];
    const active = status.state === 'connected';
    this.#tray.setImage(this.#icon(active));

    const headline =
      status.state === 'connected'
        ? t.running
        : status.state === 'login-required'
          ? t.loginRequired
          : status.state === 'error'
            ? t.error
            : status.state === 'stopped'
              ? t.stopped
              : t.connecting;

    // The host is shown because the user may need to type it into another device; nothing
    // below it explains how the connection is actually carried.
    this.#tray.setToolTip(status.host ? `LocalCast — ${headline}\n${status.host}` : `LocalCast — ${headline}`);
  }

  setLocale(locale: 'fa' | 'en'): void {
    this.#locale = locale;
  }

  destroy(): void {
    this.#tray.destroy();
  }
}
