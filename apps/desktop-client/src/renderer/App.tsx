import { useEffect, useState } from 'react';
import type { Entry, Folder } from '@localcast/contract';
import type { ClientAppInfo, ServerSummary } from '../shared/ipc.js';
import { useBridge, useServers } from './bridge.js';
import { LibraryScreen } from './screens/LibraryScreen.js';
import { PlayerScreen } from './screens/PlayerScreen.js';
import { ServersScreen } from './screens/ServersScreen.js';
import styles from './App.module.css';

/**
 * Three screens and the moves between them.
 *
 * A state machine rather than a router: this app has no URLs, no deep links and no back
 * button of its own, so a router would add a dependency and a hash in the address bar of a
 * window that has no address bar.
 *
 * The current server is held as an id and re-resolved from the live list on every render, so
 * a server that goes offline or is revoked while its library is open updates in place instead
 * of leaving a stale copy of the row on screen.
 */

type Route =
  | { name: 'servers' }
  | { name: 'library'; serverId: string }
  | { name: 'player'; serverId: string; entry: Entry; folder: Folder };

const FALLBACK_INFO: ClientAppInfo = {
  version: '0.0.0',
  locale: 'fa',
  downloadDir: '',
  deviceName: 'Windows',
};

export function App() {
  const api = useBridge();
  const { servers } = useServers();
  const [route, setRoute] = useState<Route>({ name: 'servers' });
  const [info, setInfo] = useState<ClientAppInfo>(FALLBACK_INFO);

  useEffect(() => {
    let live = true;
    void api.app.info().then((next) => {
      if (live) setInfo(next);
    });
    return () => {
      live = false;
    };
  }, [api]);

  const current: ServerSummary | null =
    route.name === 'servers'
      ? null
      : (servers.find((server) => server.id === route.serverId) ?? null);

  // A server that was revoked or removed while its library was open has nowhere to send the
  // user but back to the list. Doing it here means no screen below ever renders against a
  // server that no longer exists.
  useEffect(() => {
    if (route.name !== 'servers' && current === null) setRoute({ name: 'servers' });
  }, [route.name, current]);

  return (
    <div className={styles.shell}>
      {/* The window is frameless with an overlay title bar; this strip is the drag handle. */}
      <div className={styles.titlebar} />

      {route.name === 'servers' || current === null ? (
        <ServersScreen
          deviceName={info.deviceName}
          onOpenServer={(server) => setRoute({ name: 'library', serverId: server.id })}
        />
      ) : route.name === 'library' ? (
        <LibraryScreen
          server={current}
          downloadDir={info.downloadDir}
          onBack={() => setRoute({ name: 'servers' })}
          onPlay={(entry, folder) =>
            setRoute({ name: 'player', serverId: current.id, entry, folder })
          }
        />
      ) : (
        <PlayerScreen
          server={current}
          entry={route.entry}
          folder={route.folder}
          onBack={() => setRoute({ name: 'library', serverId: current.id })}
        />
      )}
    </div>
  );
}
