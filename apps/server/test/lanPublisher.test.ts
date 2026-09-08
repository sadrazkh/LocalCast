import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { LanPublisher } from '../src/net/lanPublisher.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

/**
 * Following the machine's address while it is running.
 *
 * Every case here was reported as the same sentence — "it is not stable, sometimes it gives an
 * address and sometimes it does not" — and every one of them is an ordinary thing that happens to
 * a laptop. The address used to be read once, inside `createServer`, and never again.
 */

type Interfaces = ReturnType<typeof os.networkInterfaces>;
type Entry = NonNullable<Interfaces[string]>[number];

function ipv4(address: string, mac = 'a2:c4:85:81:cc:0c'): Entry {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac,
    internal: false,
    cidr: `${address}/24`,
  };
}

const NO_MAC = '00:00:00:00:00:00';

/** A publisher over an interface table the test owns, so nothing depends on the host's network. */
function publisherOver(initial: Interfaces) {
  let table = initial;
  const changed: { host: string | null; previous: string | null }[] = [];
  const reissued: string[] = [];
  const publisher = new LanPublisher({
    dir: tempDir('lc-publisher-'),
    extraHosts: [],
    log: silentLogger,
    interfaces: () => table,
    onAddressChanged: (host, previous) => changed.push({ host, previous }),
    onCertificateChanged: (cert) => reissued.push(cert.fingerprint256),
    // Long enough that the timer never fires during a test; `refresh()` is driven by hand.
    intervalMs: 60_000,
  });
  return {
    publisher,
    changed,
    reissued,
    moveTo(next: Interfaces) {
      table = next;
    },
  };
}

afterAll(() => cleanupTempDirs());

describe('following this machine’s address', () => {
  it('picks the address up when Wi-Fi associates after the app started', () => {
    // The app wins the race with the network on almost every cold boot. Reading once meant the
    // panel offered nothing but the machine's own name for the rest of the session — a name a
    // phone can only use if its mDNS happens to work.
    const p = publisherOver({});
    p.publisher.start();
    const beforeWifi = p.publisher.publishHost();
    expect(beforeWifi).not.toMatch(/^\d/);

    p.moveTo({ 'Wi-Fi': [ipv4('192.168.8.92')] });
    expect(p.publisher.refresh()).toBe(true);
    expect(p.publisher.publishHost()).toBe('192.168.8.92');
    expect(p.changed).toEqual([{ host: '192.168.8.92', previous: beforeWifi }]);
  });

  it('follows a DHCP lease to a new address, and re-issues to cover it', () => {
    const p = publisherOver({ 'Wi-Fi': [ipv4('192.168.8.92')] });
    const before = p.publisher.start().fingerprint256;

    p.moveTo({ 'Wi-Fi': [ipv4('192.168.8.140')] });
    expect(p.publisher.refresh()).toBe(true);

    expect(p.publisher.publishHost()).toBe('192.168.8.140');
    // The new address has to be inside the SAN, or the phone gets a name mismatch on top of the
    // untrusted-issuer warning — and that is the kind browsers refuse to let you click through.
    const cert = p.publisher.certificate();
    expect(new X509Certificate(cert!.certPem).checkIP('192.168.8.140')).toBeDefined();
    expect(cert!.fingerprint256).not.toBe(before);
    expect(p.reissued).toEqual([cert!.fingerprint256]);
  });

  it('does not re-issue when a VPN comes up, because the tunnel is not in the certificate', () => {
    /**
     * The reason tunnels are excluded rather than ranked last.
     *
     * If a VPN's address were in the SAN, connecting or disconnecting it would change the address
     * set, issue a fresh certificate, change the fingerprint, and put the browser warning back in
     * front of every phone that had already accepted the old one. This is the test that keeps
     * "it does not matter whether the VPN is on" true.
     */
    const p = publisherOver({ 'Wi-Fi': [ipv4('192.168.8.92')] });
    const before = p.publisher.start().fingerprint256;

    p.moveTo({ XrayTun: [ipv4('10.255.0.2', NO_MAC)], 'Wi-Fi': [ipv4('192.168.8.92')] });
    expect(p.publisher.refresh()).toBe(false);

    expect(p.publisher.certificate()?.fingerprint256).toBe(before);
    expect(p.publisher.publishHost()).toBe('192.168.8.92');
    expect(p.reissued).toEqual([]);
    expect(p.changed).toEqual([]);
  });

  it('reports nothing changed when nothing changed', () => {
    const p = publisherOver({ 'Wi-Fi': [ipv4('192.168.8.92')] });
    p.publisher.start();
    expect(p.publisher.refresh()).toBe(false);
    expect(p.publisher.refresh()).toBe(false);
    expect(p.reissued).toEqual([]);
  });

  it('notices a better address appearing above the one in use', () => {
    // Ethernet plugged in on a machine already on Wi-Fi. Neither address was lost, so a set
    // comparison would call this no change — but the address that should be published has moved.
    const p = publisherOver({ 'Wi-Fi': [ipv4('10.0.0.14')] });
    p.publisher.start();
    expect(p.publisher.publishHost()).toBe('10.0.0.14');

    p.moveTo({ 'Wi-Fi': [ipv4('10.0.0.14')], Ethernet: [ipv4('192.168.1.5')] });
    expect(p.publisher.refresh()).toBe(true);
    expect(p.publisher.publishHost()).toBe('192.168.1.5');
  });

  it('falls back to the machine’s own name when the network is unplugged', () => {
    const p = publisherOver({ Ethernet: [ipv4('192.168.1.5')] });
    p.publisher.start();
    expect(p.publisher.publishHost()).toBe('192.168.1.5');

    p.moveTo({});
    expect(p.publisher.refresh()).toBe(true);
    // Not null: the hostname is in the certificate, and a device whose mDNS works can still
    // reach it. An IP would be a lie — there is no longer one to give.
    expect(p.publisher.publishHost()).not.toMatch(/^\d/);
    // The certificate itself is untouched: it still covers `localhost` and the machine name, and
    // replacing it here would burn the accepted warning on every phone for nothing.
    expect(p.reissued).toEqual([]);
  });

  it('stops watching when told to, so a disposed server holds nothing open', () => {
    const p = publisherOver({ 'Wi-Fi': [ipv4('192.168.8.92')] });
    const spy = vi.spyOn(globalThis, 'clearInterval');
    p.publisher.start();
    p.publisher.stop();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
