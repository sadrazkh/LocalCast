import { useState } from 'react';
import { Button, EmptyState, Panel, PlusIcon, QrIcon, ServerIcon, Spinner } from '@localcast/ui-kit';
import type { ServerSummary } from '../../shared/ipc.js';
import { useBridge, useServers } from '../bridge.js';
import { AddServerDialog } from '../components/AddServerDialog.js';
import { PairDialog } from '../components/PairDialog.js';
import { ServerRow } from '../components/ServerRow.js';
import { S } from '../strings.js';
import styles from './ServersScreen.module.css';

/**
 * Screen 05 — the servers this machine knows.
 *
 * Every row's state comes from the main process, where one `client-core` client per server
 * keeps its own session and its own connection monitor. Nothing here polls: the main process
 * pushes a new list whenever any of them changes.
 */

export interface ServersScreenProps {
  deviceName: string;
  onOpenServer: (server: ServerSummary) => void;
}

export function ServersScreen({ deviceName, onOpenServer }: ServersScreenProps) {
  const api = useBridge();
  const { servers, loading } = useServers();
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<ServerSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const withBusy = async (serverId: string, work: () => Promise<unknown>) => {
    setBusyId(serverId);
    try {
      await work();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.screen}>
      <Panel
        title={S.serversTitle}
        description={S.serversSubtitle}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              startIcon={<PlusIcon size={16} />}
              onClick={() => setAdding(true)}
            >
              {S.addByAddress}
            </Button>
            <Button
              variant="primary"
              size="sm"
              startIcon={<QrIcon size={16} />}
              // Pairing needs a server to pair *with*, so this offers the first row that has
              // no session rather than opening a dialogue with nothing behind it.
              disabled={servers.every((server) => server.state !== 'needs-pairing')}
              onClick={() =>
                setPairing(servers.find((server) => server.state === 'needs-pairing') ?? null)
              }
            >
              {S.pairWithCode}
            </Button>
          </>
        }
        scrollBody
      >
        {loading ? (
          <div className={styles.loading}>
            <Spinner size="md" labelled />
          </div>
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<ServerIcon size={24} />}
            title={S.serversEmpty}
            description={S.serversEmptyHint}
            actions={
              <Button variant="primary" onClick={() => setAdding(true)}>
                {S.addByAddress}
              </Button>
            }
          />
        ) : (
          <ul className={styles.list}>
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                busy={busyId === server.id}
                onOpen={onOpenServer}
                onConnect={(target) =>
                  void withBusy(target.id, () => api.servers.connect(target.id))
                }
                onPair={(target) => setPairing(target)}
                onForget={(target) => void withBusy(target.id, () => api.servers.forget(target.id))}
                onRemove={(target) => void withBusy(target.id, () => api.servers.remove(target.id))}
              />
            ))}
          </ul>
        )}
      </Panel>

      <AddServerDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSubmit={async (input) => {
          const added = await api.servers.add(input);
          // Straight into pairing: adding an address the user cannot yet reach is only half
          // an action, and the code they were given expires in five minutes.
          setPairing(added);
        }}
      />

      <PairDialog
        open={pairing !== null}
        server={pairing}
        deviceName={deviceName}
        onClose={() => setPairing(null)}
        onSubmit={async (code, target) => {
          const result = await api.servers.pair({ serverId: target.id, code, deviceName });
          // Pairing installs a session; connecting is what starts the event stream and turns
          // the row green. Doing it here means the user never has to press twice.
          if (result.ok) await api.servers.connect(target.id);
          return result;
        }}
      />
    </div>
  );
}
