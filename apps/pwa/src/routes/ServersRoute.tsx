import { useState } from 'react';
import {
  Badge,
  Button,
  ChevronEndIcon,
  ConnectionDot,
  EmptyState,
  Input,
  Modal,
  Panel,
  PasswordInput,
  RadioGroup,
  ServerIcon,
  Spinner,
  formatAddress,
  useT,
} from '@localcast/ui-kit';
import type { MessageKey } from '@localcast/ui-kit';
import type { EdgeState } from '@localcast/contract';
import type { CameraState, ServiceWorkerState } from '../capabilities/detect.js';
import { useCapabilities } from '../capabilities/store.js';
import { useClient, useClientContext, useConnectionState } from '../client/ClientProvider.js';
import { useAsync } from '../hooks/useAsync.js';
import { useServerEvent } from '../hooks/useServerEvent.js';
import { useAppT, type AppMessageKey } from '../i18n/messages.js';
import { buildHref, navigate } from '../router.js';
import { Screen, toDotState } from '../components/Screen.js';
import styles from './ServersRoute.module.css';

const EDGE_LABEL: Record<EdgeState, MessageKey> = {
  stopped: 'edge.stopped',
  starting: 'edge.starting',
  'login-required': 'edge.login-required',
  connecting: 'edge.connecting',
  'obtaining-certificate': 'edge.obtaining-certificate',
  connected: 'edge.connected',
  error: 'edge.error',
};

/**
 * One label per outcome, so the screen can never say "unavailable" without saying why.
 *
 * `refused` is the one this whole mechanism exists for: the browser loaded the page over an
 * origin whose certificate it was asked to accept, and then declined to register a worker on
 * it anyway. Naming that precisely is the difference between a user thinking the app is broken
 * and a user knowing their browser made a decision.
 */
const SERVICE_WORKER_LABEL: Record<ServiceWorkerState, AppMessageKey> = {
  registered: 'capabilities.swRegistered',
  refused: 'capabilities.swRefused',
  'insecure-context': 'capabilities.swInsecure',
  unsupported: 'capabilities.swUnsupported',
  failed: 'capabilities.swFailed',
  pending: 'capabilities.swPending',
};

const CAMERA_LABEL: Record<CameraState, AppMessageKey> = {
  available: 'capabilities.cameraAvailable',
  'insecure-context': 'capabilities.cameraInsecure',
  unsupported: 'capabilities.cameraUnsupported',
};

export interface ServersRouteProps {
  /** `''` for the list, `network` for screen 15, `remote` for screen 16. */
  view: '' | 'network' | 'remote';
}

export function ServersRoute({ view }: ServersRouteProps) {
  if (view === 'network') return <NetworkPanel />;
  if (view === 'remote') return <RemoteAccess />;
  return <ServerList />;
}

// ─── the paired server ────────────────────────────────────────────────────────

function ServerList() {
  const t = useT();
  const at = useAppT();
  const client = useClient();
  const { session } = useClientContext();
  const connection = useConnectionState();
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const me = useAsync(async (signal) => client.api.me({ signal }), [client]);

  if (session === null) {
    return (
      <Screen title={at('servers.title')}>
        <EmptyState
          icon={<ServerIcon size={28} />}
          title={at('servers.notPaired')}
          actions={
            <Button variant="primary" onClick={() => navigate('/pair')}>
              {at('servers.pairNow')}
            </Button>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen title={at('servers.title')} connection={connection}>
      <div className={styles.stack}>
        <Panel title={at('servers.thisServer')}>
          {me.loading && me.value === null ? (
            <Spinner labelled />
          ) : (
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.label}>{t('network.serverAddress')}</span>
                <span className={`${styles.value} ${styles.mono}`} data-selectable="true">
                  {formatAddress(me.value?.server.host ?? session.host)}
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>{t('app.name')}</span>
                <span className={styles.value}>{me.value?.server.name ?? '—'}</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>{at('servers.deviceName')}</span>
                <span className={styles.value}>{me.value?.device.name ?? '—'}</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>{t('network.status')}</span>
                <span className={styles.statusRow}>
                  <ConnectionDot state={toDotState(connection)} />
                </span>
              </div>
            </div>
          )}
        </Panel>

        <ConnectionPanel />

        <a className={styles.linkRow} href={buildHref('/servers/network')}>
          <span>{at('servers.advanced')}</span>
          <ChevronEndIcon size={16} />
        </a>
        <a className={styles.linkRow} href={buildHref('/servers/remote')}>
          <span>{at('remote.title')}</span>
          <ChevronEndIcon size={16} />
        </a>

        <Panel title={at('servers.davPassword')}>
          {/*
            Shown once at pairing and then only here, behind a reveal. It is the credential a
            native player is handed, so it has to be recoverable — but it is still a password
            and does not belong in plain sight on a screen someone may hand across a table.
          */}
          <PasswordInput readOnly value={session.davPassword} label={at('servers.davPassword')} />
        </Panel>

        <div className={styles.actions}>
          <Button variant="danger" onClick={() => setConfirmUnpair(true)}>
            {at('servers.unpair')}
          </Button>
        </div>
      </div>

      <Modal
        open={confirmUnpair}
        dismissible={false}
        onClose={() => setConfirmUnpair(false)}
        title={at('servers.unpair')}
        description={at('servers.unpairConfirm')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmUnpair(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                // Local only. Closing the device's access for real is an operator action on
                // Windows, and the panel is not reachable from the tailnet by design.
                void client.session.signOut();
                setConfirmUnpair(false);
                navigate('/pair', { replace: true });
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <p className={styles.remoteBody}>{at('servers.unpairConfirm')}</p>
      </Modal>
    </Screen>
  );
}

/**
 * What this browser actually granted this origin.
 *
 * Findings, not settings: nothing here is a control, because none of it is the phone's to
 * decide. It exists because the two features that depend on those grants — the offline library
 * and QR scanning — used to fail silently, and a silent failure on a phone reads as a broken
 * app rather than as a browser policy. The same facts go to the Windows panel, so the operator
 * does not have to be handed the phone to find out.
 */
function ConnectionPanel() {
  const t = useT();
  const at = useAppT();
  const { capabilities, encryptedTransport } = useCapabilities();

  return (
    <Panel title={at('capabilities.title')}>
      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.label}>{at('capabilities.encryptionLabel')}</span>
          <span className={styles.value} data-testid="capability-encryption">
            {encryptedTransport
              ? at('capabilities.encryptionOn')
              : at('capabilities.encryptionOff')}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{at('capabilities.offlineLibrary')}</span>
          <span
            className={`${styles.value} ${styles.valueWrap}`}
            data-testid="capability-offline"
          >
            {at(SERVICE_WORKER_LABEL[capabilities.serviceWorker])}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{at('capabilities.camera')}</span>
          <span className={`${styles.value} ${styles.valueWrap}`} data-testid="capability-camera">
            {at(CAMERA_LABEL[capabilities.camera])}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{at('capabilities.installed')}</span>
          <span className={styles.value}>
            {capabilities.standalone ? t('common.yes') : t('common.no')}
          </span>
        </div>
      </div>

      {capabilities.storage === 'memory' ? (
        <p className={`${styles.notice} ${styles.warning}`}>{at('capabilities.storageMemory')}</p>
      ) : null}
      {encryptedTransport ? null : (
        // The cost, stated where the consequence is visible rather than only where the choice
        // was made — the person holding the phone is rarely the person who turned this on.
        <p className={`${styles.notice} ${styles.warning}`} data-testid="capability-cost">
          {at('capabilities.unencryptedCost')}
        </p>
      )}
    </Panel>
  );
}

// ─── screen 15: «سرور هماهنگ‌کنندهٔ شبکه» ──────────────────────────────────────

/**
 * The network panel, read-only, and read-only for a reason worth stating on the screen.
 *
 * Spec §4.2: adding folders, approving devices, minting pairing codes and **changing network
 * settings** are reachable only on `127.0.0.1` behind the edge secret, "so a stolen device
 * token cannot escalate, because the endpoints that could grant privilege are not exposed to
 * the network at all". A save button here would need a route that deliberately does not
 * exist, and adding one would undo the whole boundary.
 *
 * So the panel is drawn as the canvas draws it — the two modes, the control URL, the access
 * key, the live status, and both actions — with the mutating half disabled and the reason
 * given. That is more useful than hiding it: the user can see what is configured and knows
 * exactly where to change it.
 */
function NetworkPanel() {
  const t = useT();
  const at = useAppT();
  const client = useClient();
  const { session } = useClientContext();
  const connection = useConnectionState();
  const [edge, setEdge] = useState<EdgeState | null>(null);

  useServerEvent('connection', (event) => setEdge(event.state));
  const me = useAsync(async (signal) => client.api.me({ signal }), [client]);

  const host = me.value?.server.host ?? session?.host ?? '';
  /**
   * Inferred, and labelled as inferred nowhere else because there is nowhere else to label
   * it: the device API does not publish the network mode. A `*.ts.net` name can only have
   * been issued by Tailscale's own control plane, so it is `default`; anything else is a
   * self-hosted Headscale tailnet. Wrong only if someone points a custom control server at a
   * `ts.net` name, which Tailscale does not allow.
   */
  const inferredMode: 'default' | 'custom' = host.endsWith('.ts.net') ? 'default' : 'custom';

  return (
    <Screen title={t('network.title')} back={buildHref('/servers')} connection={connection}>
      <div className={styles.stack}>
        <p className={`${styles.notice} ${styles.warning}`}>{at('servers.networkReadOnly')}</p>

        <Panel title={t('network.status')}>
          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={styles.label}>{t('connection.label')}</span>
              <span className={styles.statusRow} data-testid="edge-state">
                <ConnectionDot state={toDotState(connection)} />
                {edge === null ? null : <Badge tone="neutral">{t(EDGE_LABEL[edge])}</Badge>}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>{t('network.serverAddress')}</span>
              <span className={`${styles.value} ${styles.mono}`} data-selectable="true">
                {host.length === 0 ? '—' : formatAddress(host)}
              </span>
            </div>
          </div>
        </Panel>

        <Panel title={t('network.title')} description={t('network.certStrategy')}>
          <div className={styles.stack}>
            <RadioGroup
              name="network-mode"
              disabled
              boxed
              label={t('access.label')}
              value={inferredMode}
              onChange={() => undefined}
              options={[
                {
                  value: 'default',
                  label: t('network.modeDefault'),
                  description: t('network.modeDefaultHint'),
                },
                {
                  value: 'custom',
                  label: t('network.modeCustom'),
                  description: t('network.modeCustomHint'),
                },
              ]}
            />

            <Input
              label={t('network.controlUrl')}
              latin
              readOnly
              disabled
              value={inferredMode === 'default' ? 'https://controlplane.tailscale.com' : ''}
              placeholder={inferredMode === 'custom' ? 'https://headscale.example.net' : undefined}
              hint={t('network.modeCustomHint')}
            />

            {/*
              Never populated, in either direction. The key is stored through Electron
              `safeStorage` and the device API has no route that returns it — which is the
              point: a phone that can read the tailnet's pre-auth key can join the tailnet.
            */}
            <PasswordInput
              label={t('network.accessKey')}
              hint={t('network.accessKeyHint')}
              readOnly
              disabled
              value=""
            />

            {inferredMode === 'custom' ? (
              <p className={styles.notice}>{t('network.certUnavailableBody')}</p>
            ) : null}

            <div className={styles.actions}>
              <Button variant="primary" disabled>
                {t('network.save')}
              </Button>
              <Button variant="ghost" disabled>
                {t('network.restoreDefaults')}
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </Screen>
  );
}

// ─── screen 16: enable remote access ──────────────────────────────────────────

/**
 * The one-tap prompt.
 *
 * What the phone can actually do is narrow and worth being precise about: the sign-in that
 * `login-required` refers to happens in a browser on the Windows machine, against the control
 * plane, and the URL for it arrives on the operator API — which this device cannot reach. So
 * the tap does the one thing that is real from here: re-probe the server and report what the
 * edge says. Anything more would be a button that appears to do something and does not.
 */
function RemoteAccess() {
  const t = useT();
  const at = useAppT();
  const client = useClient();
  const connection = useConnectionState();
  const [edge, setEdge] = useState<EdgeState | null>(null);
  const [probing, setProbing] = useState(false);

  useServerEvent('connection', (event) => setEdge(event.state));

  const needsLogin = edge === 'login-required';
  const ready = connection === 'connected' && (edge === null || edge === 'connected');

  async function probe(): Promise<void> {
    setProbing(true);
    try {
      await client.api.me();
    } catch {
      // The outcome already moved the connection dot through `ApiClient.onOutcome`; there is
      // nothing here worth saying twice.
    } finally {
      setProbing(false);
    }
  }

  return (
    <Screen title={at('remote.title')} back={buildHref('/servers')} connection={connection}>
      <div className={styles.remote}>
        <ConnectionDot state={toDotState(connection)} />
        <p className={styles.remoteBody}>
          {ready ? at('remote.done') : needsLogin ? at('remote.loginRequired') : at('remote.body')}
        </p>
        {ready ? null : (
          <Button variant="primary" loading={probing} onClick={() => void probe()}>
            {needsLogin ? at('remote.pending') : at('remote.action')}
          </Button>
        )}
        {edge === null ? null : <Badge tone={ready ? 'success' : 'warning'}>{t(EDGE_LABEL[edge])}</Badge>}
      </div>
    </Screen>
  );
}
