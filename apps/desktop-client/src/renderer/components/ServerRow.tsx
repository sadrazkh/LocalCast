import { Badge, Button, ConnectionDot, ServerIcon, useFormat, useT } from '@localcast/ui-kit';
import type { BadgeTone, ConnectionState as DotState } from '@localcast/ui-kit';
import type { ServerSummary } from '../../shared/ipc.js';
import { S } from '../strings.js';
import styles from './ServerRow.module.css';

/**
 * One row of screen 05.
 *
 * The three states are shown as three different offers, not as three colours of the same
 * button: a server that needs pairing gets «ورود با کد», one that is offline gets a retry,
 * and one that is ready gets the library. A single «اتصال» button that behaves differently
 * depending on invisible state is how a user learns to distrust the screen.
 *
 * The dot is `ui-kit`'s `ConnectionDot`, which takes a state and nothing else — no host, no
 * endpoint, no `label` override. The host is rendered in the identity block above, where it
 * is the server's name rather than a claim about the transport.
 */

const TONE: Record<ServerSummary['state'], BadgeTone> = {
  paired: 'success',
  'needs-pairing': 'warning',
  offline: 'danger',
};

const STATE_LABEL: Record<ServerSummary['state'], string> = {
  paired: S.statePaired,
  'needs-pairing': S.stateNeedsPairing,
  offline: S.stateOffline,
};

/** `client-core` says `offline`; the kit's dot says `disconnected`. One word, one mapping. */
const DOT: Record<ServerSummary['connection'], DotState> = {
  connected: 'connected',
  connecting: 'connecting',
  offline: 'disconnected',
};

export interface ServerRowProps {
  server: ServerSummary;
  busy?: boolean;
  onOpen: (server: ServerSummary) => void;
  onConnect: (server: ServerSummary) => void;
  onPair: (server: ServerSummary) => void;
  onForget: (server: ServerSummary) => void;
  onRemove: (server: ServerSummary) => void;
}

export function ServerRow({
  server,
  busy = false,
  onOpen,
  onConnect,
  onPair,
  onForget,
  onRemove,
}: ServerRowProps) {
  const t = useT();
  const format = useFormat();

  return (
    <li className={styles.row} data-state={server.state}>
      <span className={styles.icon} aria-hidden="true">
        <ServerIcon size={20} />
      </span>

      <div className={styles.identity}>
        <span className={styles.label}>{server.label}</span>
        {/* ASCII, monospace, LTR-isolated: this is a host name someone may have to type. */}
        <span className={styles.host} dir="ltr">
          {format.address(server.host)}
        </span>
      </div>

      <div className={styles.status}>
        <Badge tone={TONE[server.state]} dot>
          {STATE_LABEL[server.state]}
        </Badge>
        <ConnectionDot state={DOT[server.connection]} size="sm" showLabel={false} />
      </div>

      <div className={styles.meta}>
        <span className={styles.metaLabel}>{S.lastConnected}</span>
        <span className={styles.metaValue}>
          {server.lastConnectedAt === null
            ? S.neverConnected
            : format.date(server.lastConnectedAt, 'datetime')}
        </span>
      </div>

      <div className={styles.actions}>
        {server.state === 'needs-pairing' ? (
          <Button variant="primary" size="sm" loading={busy} onClick={() => onPair(server)}>
            {S.pairWithCode}
          </Button>
        ) : server.state === 'offline' ? (
          <Button variant="secondary" size="sm" loading={busy} onClick={() => onConnect(server)}>
            {t('common.retry')}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => onOpen(server)}>
            {S.openLibrary}
          </Button>
        )}

        {server.state === 'needs-pairing' ? null : (
          <Button variant="ghost" size="sm" onClick={() => onForget(server)}>
            {S.forget}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onRemove(server)}>
          {t('common.delete')}
        </Button>
      </div>
    </li>
  );
}
