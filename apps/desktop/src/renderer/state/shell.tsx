import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EdgeStatus } from '@localcast/contract';
import { getApi } from '../lib/api.js';
import type { AppInfo } from '../lib/api.js';

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

  // Uptime is measured from when this window first saw `connected`, and reset when the edge
  // leaves that state. It is deliberately not read from the status frame: `updatedAt` moves
  // on every push, so using it would show an uptime that resets whenever a peer connects.
  useEffect(() => {
    if (status?.state === 'connected') {
      setConnectedSince((current) => current ?? Date.now());
    } else {
      setConnectedSince(null);
    }
  }, [status?.state]);

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
