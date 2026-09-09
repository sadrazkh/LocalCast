import { describe, expect, it } from 'vitest';
import { detectDeviceIdentity } from './deviceIdentity.js';

/**
 * Every phone used to be «آیفون». Three of them in the operator's list were three identical
 * rows, and the person approving could not tell which one was in front of them.
 */

const AT = new Date(2026, 8, 9, 14, 32);

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const SAMSUNG =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';

describe('naming the device that is pairing', () => {
  it.each([
    [IPHONE_SAFARI, 'iPhone · Safari · 14:32', 'ios-pwa'],
    [IPHONE_CHROME, 'iPhone · Chrome · 14:32', 'ios-pwa'],
    // iPadOS reports itself as a Mac; the `Mobile` token is what gives it away.
    [IPAD, 'iPad · Safari · 14:32', 'ios-pwa'],
    [PIXEL, 'Pixel 8 Pro · Chrome · 14:32', 'android-pwa'],
    [SAMSUNG, 'SM-S918B · Samsung · 14:32', 'android-pwa'],
    [WINDOWS_EDGE, 'Windows · Edge · 14:32', 'web'],
  ])('%s', (ua, name, platform) => {
    expect(detectDeviceIdentity(ua, AT, 'fa')).toEqual({ name, platform });
  });

  it('includes the time, which is the one thing an operator can match against the phone in hand', () => {
    const a = detectDeviceIdentity(IPHONE_SAFARI, new Date(2026, 8, 9, 9, 5));
    expect(a.name.endsWith('09:05')).toBe(true);
  });

  it('never returns an empty name', () => {
    const { name, platform } = detectDeviceIdentity('', AT, 'en');
    expect(name.length).toBeGreaterThan(0);
    expect(platform).toBe('web');
  });
});
