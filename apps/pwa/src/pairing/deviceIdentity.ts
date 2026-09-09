import type { Platform } from '@localcast/contract';

/**
 * What this phone should call itself, and what it is.
 *
 * Every device used to arrive as «آیفون», and `platform: 'ios-pwa'`, whatever it actually was —
 * so three phones in the operator's list were three identical rows, and the person approving
 * could not tell which one was in front of them. The default is now what the browser knows:
 * device family, browser, and the time the pairing started, which is the one fact an operator
 * can match against the phone in their hand («the one that just connected»). The server still
 * de-duplicates, so two of these in the same minute get «(2)» rather than colliding.
 *
 * Nothing here is authoritative — a user agent is a self-description — and none of it is used
 * for anything but a label and an icon.
 */

export interface DeviceIdentity {
  name: string;
  platform: Platform;
}

export function detectDeviceIdentity(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  now: Date = new Date(),
  locale: 'fa' | 'en' = 'fa',
): DeviceIdentity {
  const ua = userAgent;
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  const iPhone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  const windows = /Windows/.test(ua);
  const mac = /Macintosh/.test(ua) && !iPad;

  const family = iPad
    ? 'iPad'
    : iPhone
      ? 'iPhone'
      : android
        ? androidModel(ua) ?? 'Android'
        : windows
          ? 'Windows'
          : mac
            ? 'Mac'
            : locale === 'fa'
              ? 'دستگاه'
              : 'Device';

  const browser = /EdgiOS|Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung'
      : /FxiOS|Firefox\//.test(ua)
        ? 'Firefox'
        : /CriOS|Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';

  const platform: Platform = iPhone || iPad ? 'ios-pwa' : android ? 'android-pwa' : 'web';

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  // «iPhone · Safari · 14:32». ASCII digits on purpose: this is copied and compared, not read.
  const name = [family, browser, time].filter((part) => part.length > 0).join(' · ');
  return { name: name.slice(0, 64), platform };
}

/** `Android 14; Pixel 8 Pro` → `Pixel 8 Pro`; `SM-S918B` stays as the model code. */
function androidModel(ua: string): string | null {
  const match = /Android [^;)]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(ua);
  const model = match?.[1]?.trim();
  if (!model || /^(?:wv|K)$/.test(model)) return null;
  return model.length > 24 ? model.slice(0, 24) : model;
}
