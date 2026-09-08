import os from 'node:os';
import { ensureLanCertificate, type LanCertificate } from './selfSigned.js';
import { lanIpv4Addresses } from './lanAddress.js';
import type { Logger } from '../kernel.js';

/**
 * Keeps the published local-network address correct while the app is running.
 *
 * ## Why this is not a one-off read at boot
 *
 * The address was detected once, inside `createServer`, and never looked at again. Everything
 * downstream — the QR code, the pairing link, the address on the panel, the certificate's SAN —
 * came from that single reading. Which means every ordinary thing that happens to a laptop broke
 * it silently, for the rest of the session:
 *
 *   - The app starts before Wi-Fi associates. There is no address, so nothing is published, and
 *     the panel says this machine has no local network — for ever, on a machine that got one four
 *     seconds later.
 *   - The DHCP lease moves. The QR keeps naming the old address.
 *   - A VPN comes up or goes down. Same.
 *   - Somebody plugs in Ethernet. Same.
 *
 * The user's report for all four was the same sentence: it is not stable, sometimes it gives an
 * address and sometimes it does not. So the address is re-read, and when it changes the
 * certificate is re-issued to cover it and the listener is handed the new one — without dropping
 * the socket, so nothing that is streaming notices.
 *
 * ## Why polling
 *
 * Node has no interface-change event, and the platform APIs that do (`NotifyIpInterfaceChange`)
 * would be a native addon for a fact that `os.networkInterfaces()` answers from memory. The poll
 * compares a joined string of addresses and does nothing at all when it has not changed, so the
 * steady-state cost is one syscall every few seconds and no allocation worth naming.
 */

export interface LanPublisherOptions {
  /** Directory holding `lan-key.pem` and `lan-cert.pem`. */
  dir: string;
  /** Operator-configured SAN entries. The first IPv4 among them wins as the published address. */
  extraHosts: readonly string[];
  log: Logger;
  /**
   * Handed a certificate whenever the previous one has been replaced.
   *
   * The HTTPS listener adopts it through `setSecureContext`, which swaps the credentials on a
   * bound socket. Rebinding would be the alternative and it is not acceptable: a phone halfway
   * through a 4 GB film would have its connection cut because a laptop got a new DHCP lease.
   */
  onCertificateChanged?: (cert: LanCertificate) => void;
  /** Told when the published address changes, for the log line and for the panel. */
  onAddressChanged?: (host: string | null, previous: string | null) => void;
  /** How often to re-read the machine's addresses. Test seam. */
  intervalMs?: number;
  /** Test seam: the interface table, so a test can move a machine between networks. */
  interfaces?: () => ReturnType<typeof os.networkInterfaces>;
}

export class LanPublisher {
  #cert: LanCertificate | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** The address list the current certificate was issued for, joined. The change detector. */
  #signature = '';

  constructor(private readonly options: LanPublisherOptions) {}

  /** The certificate the LAN listener should be presenting right now. */
  certificate(): LanCertificate | null {
    return this.#cert;
  }

  /** The address to hand devices, or null when this machine has none. */
  publishHost(): string | null {
    return this.#cert?.publishHost ?? null;
  }

  /**
   * Issue or reload the certificate, and begin watching.
   *
   * Separate from the constructor because it touches the disk and can throw — a data directory
   * that cannot be written is a startup failure with a cause worth reporting, not a field
   * initialiser.
   */
  start(): LanCertificate {
    const cert = this.#reissue();
    const intervalMs = this.options.intervalMs ?? 5_000;
    this.#timer = setInterval(() => this.refresh(), intervalMs);
    // A timer must never be the reason the process refuses to exit.
    this.#timer.unref?.();
    return cert;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Re-read the machine's addresses and react if they moved. Returns true when something changed.
   *
   * Public because the desktop calls it directly when the user flips a network setting: waiting
   * up to the poll interval to find out whether the address is right is exactly the kind of
   * "sometimes it works" this class exists to remove.
   */
  refresh(): boolean {
    if (this.#signatureNow() === this.#signature) return false;

    const previousHost = this.#cert?.publishHost ?? null;
    const previousFingerprint = this.#cert?.fingerprint256 ?? null;
    const cert = this.#reissue();

    if (cert.fingerprint256 !== previousFingerprint) {
      this.options.log.info('local-network certificate replaced', {
        reason: 'this machine’s addresses changed',
        hosts: cert.hosts.join(', '),
        fingerprint: cert.fingerprint256,
      });
      this.options.onCertificateChanged?.(cert);
    }

    if (cert.publishHost !== previousHost) {
      this.options.log.info('local-network address changed', {
        from: previousHost ?? '(none)',
        to: cert.publishHost ?? '(none)',
      });
      this.options.onAddressChanged?.(cert.publishHost, previousHost);
    }
    return true;
  }

  #interfaces(): ReturnType<typeof os.networkInterfaces> {
    return this.options.interfaces?.() ?? os.networkInterfaces();
  }

  /**
   * The addresses, in ranked order, as one string.
   *
   * Order is part of the signature on purpose: a machine that gains an Ethernet address ranked
   * above its Wi-Fi one has not gained or lost anything from `Set`'s point of view, but the
   * address that should be published has changed.
   */
  #signatureNow(): string {
    return lanIpv4Addresses(this.#interfaces()).join(',');
  }

  #reissue(): LanCertificate {
    // Read the signature *before* issuing, from the same table the SAN will be built from. The
    // other order would let an address that appeared in between be recorded as already handled
    // and then never picked up.
    const interfaces = this.#interfaces();
    this.#signature = lanIpv4Addresses(interfaces).join(',');
    this.#cert = ensureLanCertificate({
      dir: this.options.dir,
      extraHosts: this.options.extraHosts,
      log: this.options.log,
      interfaces,
    });
    return this.#cert;
  }
}
