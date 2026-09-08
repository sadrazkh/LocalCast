import os from 'node:os';

/**
 * Which of this machine's addresses a phone on the same Wi-Fi can actually reach.
 *
 * ## The bug this exists to fix
 *
 * A Windows machine rarely has one address. A development laptop here reports two:
 *
 * ```
 * XrayTun   10.255.0.2     mac 00:00:00:00:00:00
 * Wi-Fi     192.168.8.92   mac a2:c4:85:81:cc:0c
 * ```
 *
 * Only the second one exists as far as a phone in the same room is concerned. The first is one
 * end of a VPN tunnel; nothing on the local network can route to it, and nothing ever will. The
 * previous rule here was "any private address, in whatever order `os.networkInterfaces()`
 * happens to enumerate them" — and `10.0.0.0/8` *is* private, so the tunnel won, went into the
 * QR code, and every device that scanned it timed out. Which is exactly what a user sees as
 * "it gives junk addresses instead of the local one".
 *
 * The address ranges do not separate these two. `10.0.0.0/8` is what Xfinity and a great many
 * corporate networks hand out to real hardware, so a rule that skipped `10.*` would break homes
 * that use it. What separates them is the **adapter**, so that is what this classifies.
 *
 * ## The three signals
 *
 *   1. **The adapter's name.** Tunnels and hypervisor switches are named after themselves —
 *      `XrayTun`, `Tailscale`, `vEthernet (WSL)`, `VMware Network Adapter VMnet8`, `wg0`. This
 *      is the strongest signal and the easiest to read in a bug report.
 *   2. **No hardware address.** A TUN/TAP or WinTun adapter reports `00:00:00:00:00:00` because
 *      there is no Ethernet card underneath it. Physical NICs never do.
 *   3. **`100.64.0.0/10`.** Carrier-grade NAT, which is also the range Tailscale assigns. Never
 *      a local network.
 *
 * ## Why tunnels are excluded rather than merely ranked last
 *
 * They still lose ties, but the reason to drop them entirely is the certificate. Its SAN is
 * derived from this list, and `ensureLanCertificate` reissues whenever the machine holds an
 * address the stored certificate does not cover. If a VPN's address were in the SAN, then
 * connecting or disconnecting that VPN would change the address set, issue a fresh certificate,
 * change the fingerprint — and put the browser warning back in front of every phone that had
 * already accepted the old one. Leaving them out is what makes "it does not matter whether the
 * VPN is on" true rather than aspirational.
 *
 * The one exception is a machine that has *nothing else*. There, a tunnel address is still
 * better than publishing no address at all, so the classification is kept and the exclusion is
 * dropped — see `lanIpv4Addresses`.
 */

export interface LanCandidate {
  /** The IPv4 address. */
  address: string;
  /** The adapter's name exactly as the OS reports it: `Wi-Fi`, `Ethernet 2`, `XrayTun`. */
  adapter: string;
  /** True when this address belongs to a tunnel, a virtual switch or a container bridge. */
  tunnel: boolean;
  /** Which signal decided it. Written to the log, so a wrong pick can be diagnosed remotely. */
  note: string;
}

/**
 * Adapter names that are distinctive enough to match anywhere in the string.
 *
 * Windows friendly names are long and full of vendor words (`VMware Network Adapter VMnet8`,
 * `TAP-Windows Adapter V9`, `Microsoft Teredo Tunneling Adapter`), so a plain substring is both
 * sufficient and the least surprising rule. Everything here names a product or a subsystem; none
 * of them is a word that could plausibly appear in the name of a real Ethernet or Wi-Fi adapter.
 */
const TUNNEL_NAME =
  /(vpn|tailscale|zerotier|hamachi|radmin|wireguard|wintun|openvpn|softether|nordlynx|proton|mullvad|expressvpn|surfshark|windscribe|anyconnect|forticlient|globalprotect|zscaler|netbird|twingate|sonicwall|checkpoint|pulse secure|xray|v2ray|clash|sing-?box|hiddify|outline|warp|vethernet|hyper-v|vmware|vmnet|virtualbox|vbox|parallels|docker|wsl|npcap|teredo|isatap|6to4|bluetooth|pdanet|loopback)/i;

/**
 * Short adapter names that are only meaningful whole: `tun0`, `wg1`, `br-1a2b`, `utun4`.
 *
 * These need boundaries. `tap` as a bare substring would match nothing real today but is two
 * letters away from doing so, and the cost of a false positive here is the app refusing to
 * publish the one address that works.
 */
const TUNNEL_TOKEN = /(?:^|[^a-z0-9])(?:tun|tap|ppp|wg|utun|veth|br)[0-9]*(?:$|[^a-z0-9])/i;

/** No Ethernet card underneath. A TUN device has no MAC to report, so it reports zeroes. */
const NO_HARDWARE_ADDRESS = /^(?:00[:-]){5}00$/;

/** `100.64.0.0/10` — carrier-grade NAT, and the range Tailscale hands out. Never a LAN. */
function isCarrierGradeNat(ip: string): boolean {
  return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}

/**
 * How likely a range is to be the network the phone is on, lowest number first.
 *
 * `192.168.0.0/16` is what consumer routers hand out almost without exception, so it wins when a
 * machine holds several real addresses. The rest of RFC 1918 follows, and anything else — a
 * routable address on a NIC, which happens on a server — comes last but is still offered, since
 * it is reachable and refusing to name it would leave the user with nothing.
 */
function rangeRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  if (ip.startsWith('10.')) return 2;
  return 3;
}

function classify(adapter: string, address: string, mac: string): Pick<LanCandidate, 'tunnel' | 'note'> {
  if (TUNNEL_NAME.test(adapter) || TUNNEL_TOKEN.test(adapter)) {
    return { tunnel: true, note: 'virtual or tunnel adapter, by name' };
  }
  if (NO_HARDWARE_ADDRESS.test(mac)) {
    return { tunnel: true, note: 'no hardware address' };
  }
  if (isCarrierGradeNat(address)) {
    return { tunnel: true, note: 'carrier-grade NAT range' };
  }
  return { tunnel: false, note: 'local network adapter' };
}

/**
 * Every IPv4 address this machine holds, classified and ordered best-first.
 *
 * Loopback and link-local (`169.254.*`, the address Windows invents when DHCP fails) are dropped
 * outright: neither is an address another device can be given.
 *
 * Exported for the log line and for tests. Callers that want an address want
 * `lanIpv4Addresses`.
 */
export function lanCandidates(interfaces = os.networkInterfaces()): LanCandidate[] {
  const found: LanCandidate[] = [];
  for (const [adapter, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      found.push({
        address: address.address,
        adapter,
        ...classify(adapter, address.address, address.mac),
      });
    }
  }

  // Real adapters before tunnels, then by range. `sort` is stable in Node, so two addresses that
  // tie on both keys stay in the order the OS enumerated them.
  return found.sort(
    (a, b) =>
      Number(a.tunnel) - Number(b.tunnel) || rangeRank(a.address) - rangeRank(b.address),
  );
}

/**
 * The machine's addresses on the local network, best first.
 *
 * Tunnel and virtual addresses are left out — unless they are all there is, in which case
 * publishing one is still better than publishing nothing, and a machine whose only network is a
 * VPN is a machine where that VPN *is* the local network.
 */
export function lanIpv4Addresses(interfaces = os.networkInterfaces()): string[] {
  const all = lanCandidates(interfaces);
  const real = all.filter((candidate) => !candidate.tunnel);
  return (real.length > 0 ? real : all).map((candidate) => candidate.address);
}
