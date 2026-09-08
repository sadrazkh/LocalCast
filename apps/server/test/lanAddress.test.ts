import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { lanCandidates, lanIpv4Addresses } from '../src/net/lanAddress.js';
import { defaultSanHosts, generateLanCertificate } from '../src/net/selfSigned.js';

/**
 * Picking the address a phone can actually reach.
 *
 * These are the machine's own network as data. `os.networkInterfaces()` is injectable precisely
 * so this can be tested — the alternative is a suite that passes or fails depending on whether
 * the developer happened to have a VPN running, which is the bug rather than a test of it.
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

describe('choosing the local-network address', () => {
  it('prefers the Wi-Fi adapter over a VPN tunnel, whatever order the OS lists them in', () => {
    /**
     * The exact shape of the reported bug, copied from the machine it happened on.
     *
     * `10.0.0.0/8` is a private range, so the old rule — "the first private address" — took the
     * tunnel, put `10.255.0.2` in the QR code, and every phone that scanned it timed out. The
     * tunnel is listed first here on purpose: enumeration order is what decided it before.
     */
    const addresses = lanIpv4Addresses({
      XrayTun: [ipv4('10.255.0.2', NO_MAC)],
      'Wi-Fi': [ipv4('192.168.8.92')],
    });

    expect(addresses[0]).toBe('192.168.8.92');
    // Not merely ranked below: absent. A tunnel address in the SAN means a new certificate, and
    // a new browser warning, every time the VPN is switched on or off.
    expect(addresses).not.toContain('10.255.0.2');
  });

  it('keeps a 10.x address that belongs to a real adapter', () => {
    // Comcast and a great many office networks hand out 10.x to actual hardware. A rule that
    // skipped the range rather than the adapter would leave those homes unable to connect at all.
    expect(lanIpv4Addresses({ Ethernet: [ipv4('10.0.0.14')] })).toEqual(['10.0.0.14']);
  });

  it.each([
    ['XrayTun', '10.255.0.2', NO_MAC],
    ['Tailscale', '100.101.102.103', NO_MAC],
    ['vEthernet (WSL)', '172.28.16.1', '00:15:5d:01:02:03'],
    ['VMware Network Adapter VMnet8', '192.168.116.1', '00:50:56:c0:00:08'],
    ['Radmin VPN', '26.1.2.3', '0a:00:27:00:00:01'],
    ['wg0', '10.8.0.2', NO_MAC],
    ['docker0', '172.17.0.1', '02:42:9d:1e:2f:30'],
  ])('leaves out %s', (adapter, address, mac) => {
    const seen = lanCandidates({ [adapter]: [ipv4(address, mac)], 'Wi-Fi': [ipv4('192.168.1.5')] });
    expect(seen.find((c) => c.adapter === adapter)?.tunnel).toBe(true);
    expect(lanIpv4Addresses({ [adapter]: [ipv4(address, mac)], 'Wi-Fi': [ipv4('192.168.1.5')] })).toEqual([
      '192.168.1.5',
    ]);
  });

  it.each([
    ['Wi-Fi', '192.168.1.5'],
    ['Ethernet 2', '192.168.1.6'],
    ['Realtek PCIe GbE Family Controller', '10.0.0.7'],
    ['Broadcom NetXtreme Gigabit Ethernet', '192.168.2.8'],
    // Windows names the mobile-hotspot adapter this. A phone joined to the PC's own hotspot is
    // on the local network by any definition, so it must not be filtered out with the tunnels.
    ['Local Area Connection* 12', '192.168.137.1'],
  ])('keeps %s', (adapter, address) => {
    expect(lanIpv4Addresses({ [adapter]: [ipv4(address)] })).toEqual([address]);
  });

  it('ranks 192.168 ahead of the other private ranges', () => {
    // All three are real adapters here. When a machine genuinely has several, the range a
    // consumer router hands out is the one the phone is most likely to be on.
    expect(
      lanIpv4Addresses({
        Ethernet: [ipv4('10.0.0.3')],
        'Ethernet 2': [ipv4('172.20.0.4')],
        'Wi-Fi': [ipv4('192.168.1.5')],
      }),
    ).toEqual(['192.168.1.5', '172.20.0.4', '10.0.0.3']);
  });

  it('falls back to the tunnel when it is the only network there is', () => {
    // A laptop on a full-tunnel VPN with the Wi-Fi down still has to publish something, and
    // there the tunnel is the local network as far as anything can tell.
    expect(lanIpv4Addresses({ XrayTun: [ipv4('10.255.0.2', NO_MAC)] })).toEqual(['10.255.0.2']);
  });

  it('ignores loopback, link-local and IPv6', () => {
    const addresses = lanIpv4Addresses({
      'Loopback Pseudo-Interface 1': [{ ...ipv4('127.0.0.1', NO_MAC), internal: true }],
      // What Windows invents when DHCP never answers. Handing it to a phone is handing it nothing.
      Ethernet: [ipv4('169.254.10.20')],
      'Wi-Fi': [
        { ...ipv4('192.168.1.5'), family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64' },
        ipv4('192.168.1.5'),
      ],
    });
    expect(addresses).toEqual(['192.168.1.5']);
  });

  it('says why each address was skipped', () => {
    // The line this feeds is the one that turns "it gives a junk address" into a diagnosis
    // without anyone having to reproduce the user's network.
    const seen = lanCandidates({ XrayTun: [ipv4('10.255.0.2', NO_MAC)] });
    expect(seen[0]).toMatchObject({ address: '10.255.0.2', adapter: 'XrayTun', tunnel: true });
    expect(seen[0]?.note).toMatch(/tunnel|hardware/i);
  });
});

describe('the address that ends up in the certificate', () => {
  it('publishes the first entry of the SAN set', () => {
    const cert = generateLanCertificate({ hosts: ['localhost', '127.0.0.1', '192.168.8.92', '10.255.0.2'] });
    // Ordering is the whole mechanism: `defaultSanHosts` ranks, and this takes the top. A second
    // opinion here — "any private address" — is what previously overrode the ranking.
    expect(cert.publishHost).toBe('192.168.8.92');
  });

  it('lets a configured address win over detection', () => {
    // The escape hatch for a machine where detection still picks the wrong real adapter. It has
    // to be in the SAN as well as published, or the phone meets a name mismatch it cannot dismiss.
    const hosts = defaultSanHosts(['192.168.99.99']);
    expect(generateLanCertificate({ hosts }).publishHost).toBe('192.168.99.99');
  });

  it('falls back to a name when the machine has no address at all', () => {
    const cert = generateLanCertificate({ hosts: ['localhost', '127.0.0.1', 'sadra.local'] });
    expect(cert.publishHost).toBe('sadra.local');
  });
});
