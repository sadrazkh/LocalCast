import type { LanCertificate } from './selfSigned.js';

/**
 * Every address this machine currently answers on for the local network, and what each one
 * costs.
 *
 * ## Why there is a `.local` name here, and why nothing advertises it over mDNS
 *
 * The complaint mDNS is usually reached for is real: the published address is
 * `https://192.168.1.50:8443`, that address is a DHCP lease, and when the lease moves the
 * certificate's SAN no longer covers the machine — so `ensureLanCertificate` issues a new one,
 * the fingerprint changes, and **every device meets the browser warning again**. A name that
 * survives the lease fixes that.
 *
 * What a `.local` name does **not** fix is trust. A self-signed certificate for
 * `localcast.local` is exactly as untrusted as a self-signed certificate for an IP address:
 * the browser's objection is to the issuer, not to the spelling of the subject. Anyone
 * reaching for mDNS as an answer to the certificate problem is answering a different question.
 *
 * And the name is already here. Windows 10 and 11 run their own mDNS responder and publish
 * `<hostname>.local` on the LAN with nothing installed — verified on the development machine,
 * where `ping sadra.local` resolves to the LAN address while `nslookup` (which does not speak
 * mDNS) does not. `defaultSanHosts` already puts `<hostname>.local` into the certificate. So
 * the useful part of mDNS costs zero dependencies and zero code: it is a name we can *publish*
 * in the panel, not a protocol we have to implement.
 *
 * A `_localcast._tcp` service advertisement is a different feature and is deliberately not
 * built. No browser can consume one — there is no web API for DNS-SD — and the browser is the
 * client this exists for. It would only serve a native client, and a native client is already
 * handed a URL and a fingerprint by the QR payload. Writing several hundred lines of multicast
 * DNS (probing, conflict resolution, cache-flush bits, goodbye packets) to save the desktop
 * client a field it already has is not a trade worth making.
 *
 * The IP stays the published address rather than the name, because `.local` resolution is
 * native on iOS, macOS and Windows but has been unreliable on Android — an address that works
 * everywhere belongs in the QR code, and the name belongs next to it as the one to write down.
 */

export interface LanAddress {
  url: string;
  /** `ip` survives nothing; `name` survives a DHCP lease but needs an mDNS-capable client. */
  kind: 'ip' | 'name';
  encrypted: boolean;
}

export interface LanAccess {
  /**
   * Addresses on the encrypted listener. The first is what the QR code carries.
   * Empty when local sharing is off.
   */
  secure: LanAddress[];
  /**
   * Addresses on the unencrypted listener. Empty unless somebody deliberately turned it on,
   * and never published in a QR code — the only way to reach it is to be told it by the panel.
   */
  plaintext: LanAddress[];
  /** The certificate the `secure` addresses present, for pinning and for the panel. */
  fingerprint256: string | null;
}

export interface LanAccessInput {
  certificate: LanCertificate | null;
  /** Bound port of the HTTPS listener, or null when it is not listening. */
  tlsPort: number | null;
  /** Bound port of the plain-HTTP listener, or null — which is the normal case. */
  plaintextPort: number | null;
}

/**
 * The `.local` name from the certificate's SAN, if it has one.
 *
 * Taken from the certificate rather than from `os.hostname()` a second time, so the address
 * offered is always one the certificate actually covers — a name that is not in the SAN would
 * produce a *second* warning, about the name, and that is the kind browsers do not let you
 * click through.
 */
function localName(hosts: readonly string[]): string | null {
  return hosts.find((host) => host.endsWith('.local')) ?? null;
}

export function buildLanAccess(input: LanAccessInput): LanAccess {
  const cert = input.certificate;
  const hosts = cert?.hosts ?? [];
  const name = localName(hosts);

  const addresses = (port: number | null, encrypted: boolean): LanAddress[] => {
    if (port === null) return [];
    const scheme = encrypted ? 'https' : 'http';
    const out: LanAddress[] = [];
    if (cert?.publishHost != null) {
      out.push({ url: `${scheme}://${cert.publishHost}:${port}`, kind: 'ip', encrypted });
    }
    // Only when it is a different string: on a machine with no LAN IPv4 the publish host is
    // already the name, and listing it twice would read as two addresses to try.
    if (name !== null && name !== cert?.publishHost) {
      out.push({ url: `${scheme}://${name}:${port}`, kind: 'name', encrypted });
    }
    return out;
  };

  return {
    secure: addresses(input.tlsPort, true),
    plaintext: addresses(input.plaintextPort, false),
    fingerprint256: cert?.fingerprint256 ?? null,
  };
}
