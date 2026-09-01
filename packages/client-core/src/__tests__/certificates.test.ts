import { describe, expect, it } from 'vitest';
import type { QrPayload } from '@localcast/contract';
import { endpointFromQr, fingerprintsMatch, normaliseFingerprint } from '../certificates.js';

/**
 * The pin is the only thing standing between "encrypted" and "encrypted to whoever answered",
 * and the four layers involved each spell it differently. A comparison that fails on
 * punctuation is one somebody eventually deletes.
 */

const NODE = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const BARE = NODE.replace(/:/g, '');

describe('normaliseFingerprint', () => {
  it('accepts every spelling the platforms actually produce', () => {
    expect(normaliseFingerprint(NODE)).toBe(NODE);
    expect(normaliseFingerprint(BARE.toLowerCase())).toBe(NODE);
    expect(normaliseFingerprint(`  ${NODE.toLowerCase()}  `)).toBe(NODE);
    expect(normaliseFingerprint(`SHA256 Fingerprint=${NODE}`)).toBe(NODE);
    expect(normaliseFingerprint(`sha256:${BARE}`)).toBe(NODE);
  });

  it('accepts the base64 form Electron hands to setCertificateVerifyProc', () => {
    // Electron reports `sha256/<base64 of the 32 raw bytes>`.
    const base64 = Buffer.from(BARE, 'hex').toString('base64');
    expect(normaliseFingerprint(`sha256/${base64}`)).toBe(NODE);
    expect(normaliseFingerprint(base64)).toBe(NODE);
  });

  it('refuses anything that is not 32 bytes, rather than passing it along', () => {
    // Null is a refusal. A caller that treats it as "no pin needed" has inverted the meaning,
    // which is why `fingerprintsMatch` returns false for it below rather than true.
    expect(normaliseFingerprint('')).toBeNull();
    expect(normaliseFingerprint(null)).toBeNull();
    expect(normaliseFingerprint('AB:CD')).toBeNull();
    expect(normaliseFingerprint(`${BARE}00`)).toBeNull();
    expect(normaliseFingerprint('not a fingerprint at all')).toBeNull();
  });
});

describe('fingerprintsMatch', () => {
  it('matches across spellings', () => {
    const base64 = Buffer.from(BARE, 'hex').toString('base64');
    expect(fingerprintsMatch(NODE, `sha256/${base64}`)).toBe(true);
    expect(fingerprintsMatch(NODE.toLowerCase(), BARE)).toBe(true);
  });

  it('is false when either side is missing or unparseable', () => {
    expect(fingerprintsMatch(NODE, null)).toBe(false);
    expect(fingerprintsMatch(undefined, NODE)).toBe(false);
    expect(fingerprintsMatch('', '')).toBe(false);
  });

  it('is false for a certificate that differs by one byte', () => {
    const off = `${NODE.slice(0, -1)}A`;
    expect(fingerprintsMatch(NODE, off)).toBe(false);
  });
});

describe('endpointFromQr', () => {
  const base: QrPayload = {
    v: 1,
    host: 'ali-pc.tail1234.ts.net',
    code: 'AB23',
    secret: 'x'.repeat(43),
  };

  it('uses the tailnet host on 443 with no pin', () => {
    // A publicly-trusted certificate. `null` here means "verify normally", not "skip".
    expect(endpointFromQr(base)).toEqual({
      baseUrl: 'https://ali-pc.tail1234.ts.net',
      pinnedFingerprint: null,
    });
  });

  it('prefers the explicit origin and its pin on the local network', () => {
    expect(endpointFromQr({ ...base, url: 'https://192.168.1.50:8443', fp: NODE })).toEqual({
      baseUrl: 'https://192.168.1.50:8443',
      pinnedFingerprint: NODE,
    });
  });
});
