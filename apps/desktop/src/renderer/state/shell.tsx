import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { edgeStateToConnection } from '@localcast/ui-kit';
import type { ConnectionState } from '@localcast/ui-kit';
import type { EdgeStatus } from '@localcast/contract';
import { getApi } from '../lib/api.js';
import type { AppInfo } from '../lib/api.js';
import { REMOTE_ACCESS_ENABLED } from '../../shared/features.js';

/**
 * The shell state every surface in this window shares: the live edge status and the static
 * app info.
 *
 * **There is exactly one `edge.onEvent` subscription per window, and it is here.** The main
 * process pushes a status frame to every window whenever the sidecar's state changes; a
 * second subscriber would double the work for no new information, and a `setInterval` would
 * replace a push that already exists with a poll that can only ever be more stale.
 */

export interface ShellValue {
  /** `null` until the first frame arrives — which is not the same as "stopped". */
  status: EdgeStatus | null;
  info: AppInfo | null;
  /** When this window first saw a `connected` status, for the uptime readout. */
  connectedSince: number | null;
  refreshInfo: () => void;
}

const ShellContext = createContext<ShellValue>({
  status: null,
  info: null,
  connectedSince: null,
  refreshInfo: () => undefined,
});

export function ShellProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoNonce, setInfoNonce] = useState(0);
  const [connectedSince, setConnectedSince] = useState<number | null>(null);

  // A pushed frame always wins over the initial `status()` fetch, which may land after it.
  const pushed = useRef(false);

  useEffect(() => {
    const api = getApi();
    const off = api.edge.onEvent((next) => {
      pushed.current = true;
      setStatus(next);
    });

    void api.edge
      .status()
      .then((initial) => {
        if (!pushed.current) setStatus(initial);
      })
      .catch(() => {
        // A status call that fails means the sidecar is not answering yet. The dot stays at
        // its "not known" state rather than claiming a disconnection we have not observed.
      });

    return off;
  }, []);

  useEffect(() => {
    void getApi()
      .app.info()
      .then(setInfo)
      .catch(() => undefined);
  }, [infoNonce]);

  // Uptime is measured from when this window first saw the server on, and reset when it goes
  // off again. It is deliberately not read from the status frame: `updatedAt` moves on every
  // push, so using it would show an uptime that resets whenever a peer connects.
  //
  // `isServerOn`, not the edge state directly: with remote access switched off the edge never
  // reports `connected`, and «مدت روشن بودن» would read «—» for ever beside a server that has
  // been up since boot.
  const serverOn = isServerOn(status, info);
  useEffect(() => {
    if (serverOn) {
      setConnectedSince((current) => current ?? Date.now());
    } else {
      setConnectedSince(null);
    }
  }, [serverOn]);

  const value = useMemo<ShellValue>(
    () => ({ status, info, connectedSince, refreshInfo: () => setInfoNonce((n) => n + 1) }),
    [status, info, connectedSince],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  return useContext(ShellContext);
}

/** True once the edge is serving. Everything user-visible branches on this, not on a count. */
export function isServing(status: EdgeStatus | null): boolean {
  return status?.state === 'connected';
}

/**
 * Is the server on — as a *user* means it, in the build they are actually running.
 *
 * With remote access switched off the sidecar is never started, so its status is permanently
 * `stopped`. Reading `isServing` in that build would paint «سرور خاموش است» and a red dot over
 * a server that is happily serving the local network, and offer a button to turn on something
 * that is already on. The honest signal in that mode is the local server's own listening
 * port, which `app.info()` reports as soon as its socket is bound.
 *
 * Both branches stay compiled: switch the flag back on and the edge is the answer again.
 */
export function isServerOn(status: EdgeStatus | null, info: AppInfo | null): boolean {
  return REMOTE_ACCESS_ENABLED ? isServing(status) : (info?.serverPort ?? 0) > 0;
}

/**
 * The address to show as «نشانی سرور».
 *
 * `status.host` is the name the coordination server hands out, so it is null for the whole
 * life of a local-only build; `info.lanUrl` is the address a phone on this Wi-Fi actually
 * types. Falling back to it keeps the field from reading «هنوز آماده نیست» beside a server
 * that has been ready since boot.
 */
export function serverAddress(status: EdgeStatus | null, info: AppInfo | null): string | null {
  if (REMOTE_ACCESS_ENABLED) return status?.host ?? null;
  return info?.lanUrl ?? null;
}

/** What the dot should show: the edge's own state, or the local server's, per the flag. */
export function connectionOf(status: EdgeStatus | null, info: AppInfo | null): ConnectionState {
  if (REMOTE_ACCESS_ENABLED) return edgeStateToConnection(status?.state ?? 'starting');
  // Two honest answers only. There is nothing to be «قطع» about while the app is running:
  // either the local server has its socket, or it has not got it yet.
  return isServerOn(status, info) ? 'connected' : 'connecting';
}
