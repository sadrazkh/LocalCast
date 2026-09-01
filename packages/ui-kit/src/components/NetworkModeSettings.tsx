import type { ReactNode } from 'react';
import type { CertStrategy, EdgeStatus, EdgeTestResult, Expose, NetworkMode } from '@localcast/contract';
import { useFormat, useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import { AlertIcon, InfoIcon } from '../icons/index.js';
import { Button } from './Button.js';
import { ConnectionDot, edgeStateToConnection } from './ConnectionDot.js';
import { Input } from './Input.js';
import { Panel } from './Panel.js';
import { PasswordInput } from './PasswordInput.js';
import { RadioGroup } from './Radio.js';
import { Select } from './Select.js';
import styles from './NetworkModeSettings.module.css';

/**
 * Mirrors `dnsProviderSchema` in `@localcast/contract`, which exports the schema value but
 * not its inferred type. Kept as a plain union so this package does not have to take a
 * direct dependency on zod for one string list.
 */
export type DnsProvider = 'cloudflare' | 'digitalocean' | 'route53' | 'gandi';

/**
 * The editable form state.
 *
 * Every field is a plain string, because that is what an `<input>` holds: `NetworkConfig`
 * from the contract is the *parsed* shape, and forcing a half-typed URL through it would
 * mean the form could not represent its own intermediate states.
 */
export interface NetworkConfigDraft {
  mode: NetworkMode;
  controlUrl: string;
  authKey: string;
  expose: Expose;
  certStrategy: CertStrategy;
  certDomain: string;
  dnsProvider: DnsProvider | '';
  dnsApiToken: string;
  hostname: string;
}

export interface NetworkModeSettingsProps {
  value: NetworkConfigDraft;
  onChange: (next: NetworkConfigDraft) => void;
  /** Live edge status. `null` before the first status frame arrives. */
  status?: EdgeStatus | null;
  /** Result of the last dry run. `null` means the draft has not been tested yet. */
  testResult?: EdgeTestResult | null;
  testing?: boolean;
  saving?: boolean;
  onTest: () => void;
  onSave: () => void;
  onRestoreDefaults: () => void;
  /**
   * Slot for the certificate explanation.
   *
   * Left as a slot rather than hard-wired so the Electron and PWA layers can put the exact
   * wording — and any link to the tracking issues — in place. When it is omitted and
   * `certificateUnavailable` is set, the built-in Persian/English text is used, because this
   * state must never be silent.
   */
  certificateNotice?: ReactNode;
  /**
   * True when the draft's control server cannot issue a certificate on its own — Headscale
   * with `control-plane` selected. Spec §2.3: this must be shown, not spun on.
   */
  certificateUnavailable?: boolean;
  /** Disables everything while another operation owns the edge. */
  disabled?: boolean;
  className?: string;
}

const EDGE_STATE_LABEL: Record<EdgeStatus['state'], MessageKey> = {
  stopped: 'edge.stopped',
  starting: 'edge.starting',
  'login-required': 'edge.login-required',
  connecting: 'edge.connecting',
  'obtaining-certificate': 'edge.obtaining-certificate',
  connected: 'edge.connected',
  error: 'edge.error',
};

/**
 * The whole «سرور هماهنگ‌کنندهٔ شبکه» panel from screens 14 and 15.
 *
 * Purely presentational: it takes a draft and callbacks and renders them. The Electron main
 * process and the PWA own `/edge/test`, `/edge/config` and the status stream.
 *
 * Two rules the layout encodes:
 *
 * 1. **Test before save.** Save is disabled until a dry run has returned `ok`. A mode that
 *    cannot work fails while the operator is still looking at the form, rather than becoming
 *    a permanent «در حال تلاش» after they walk away.
 * 2. **A certificate that cannot be issued is stated, not spun.** Headscale has not
 *    implemented `/machine/set-dns`, so `control-plane` issuance is impossible there. That
 *    is a fact about the mode, and it gets a persistent notice next to the control that
 *    caused it.
 *
 * The status block does show the server address — that is the operator's own settings page,
 * and they need it to point a client at the machine. The coarse `ConnectionDot` is the thing
 * that must never carry transport detail, and it does not.
 */
export function NetworkModeSettings({
  value,
  onChange,
  status = null,
  testResult = null,
  testing = false,
  saving = false,
  onTest,
  onSave,
  onRestoreDefaults,
  certificateNotice,
  certificateUnavailable = false,
  disabled = false,
  className,
}: NetworkModeSettingsProps) {
  const t = useT();
  const format = useFormat();

  const patch = (next: Partial<NetworkConfigDraft>) => onChange({ ...value, ...next });
  const isCustom = value.mode === 'custom';
  const canSave = testResult?.ok === true && !saving && !disabled;

  const showNotice = certificateUnavailable || certificateNotice !== undefined;

  return (
    <Panel
      title={t('network.title')}
      className={className}
      footerStart={canSave ? null : <span className={styles.blockedNote}>{t('network.saveBlocked')}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={onRestoreDefaults} disabled={disabled || saving}>
            {t('network.restoreDefaults')}
          </Button>
          <Button variant="secondary" onClick={onTest} loading={testing} disabled={disabled}>
            {testing ? t('network.testing') : t('network.test')}
          </Button>
          <Button variant="primary" onClick={onSave} loading={saving} disabled={!canSave}>
            {t('network.save')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {/* ── live status ───────────────────────────────────────────────────────── */}
        {status ? (
          <div className={styles.status}>
            <div className={styles.statusItem}>
              <span className={styles.statusLabel}>{t('network.status')}</span>
              <span className={styles.statusValue}>
                <ConnectionDot state={edgeStateToConnection(status.state)} showLabel={false} />{' '}
                {t(EDGE_STATE_LABEL[status.state])}
              </span>
            </div>

            {status.host ? (
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>{t('network.serverAddress')}</span>
                <span className={styles.latin}>{format.address(status.host)}</span>
              </div>
            ) : null}

            {status.funnelUrl ? (
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>{t('network.publicAddress')}</span>
                <span className={styles.latin}>{status.funnelUrl}</span>
              </div>
            ) : null}

            <div className={styles.statusItem}>
              <span className={styles.statusLabel}>{t('network.peers')}</span>
              <span className={styles.statusValue}>{format.count(status.peers)}</span>
            </div>

            {status.certExpiresAt !== null ? (
              <div className={styles.statusItem}>
                <span className={styles.statusLabel}>{t('network.certExpires')}</span>
                <span className={styles.statusValue}>{format.date(status.certExpiresAt)}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── default vs personal control server ────────────────────────────────── */}
        <RadioGroup<NetworkMode>
          name="lc-network-mode"
          label={t('network.title')}
          boxed
          value={value.mode}
          disabled={disabled}
          onChange={(mode) =>
            patch({
              mode,
              // Leaving `control-plane` selected under Headscale would produce a config the
              // contract's own refinement rejects, so the strategy moves with the mode.
              certStrategy: mode === 'default' ? 'control-plane' : 'external-proxy',
              expose: mode === 'default' ? value.expose : 'tailnet',
            })
          }
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

        {/* ── the certificate reality for the chosen mode ───────────────────────── */}
        {showNotice ? (
          <div className={styles.notice} role="status">
            <span className={styles.noticeIcon}>
              <AlertIcon size={16} />
            </span>
            <div className={styles.noticeBody}>
              {certificateNotice ?? (
                <>
                  <span className={styles.noticeTitle}>{t('network.certUnavailableTitle')}</span>
                  <span className={styles.noticeText}>{t('network.certUnavailableBody')}</span>
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* ── fields ────────────────────────────────────────────────────────────── */}
        <div className={styles.fields}>
          <Input
            label={t('network.hostname')}
            latin
            value={value.hostname}
            disabled={disabled}
            onChange={(event) => patch({ hostname: event.target.value })}
          />

          {isCustom ? (
            <>
              <Input
                label={t('network.controlUrl')}
                latin
                required
                placeholder="https://headscale.example.com"
                value={value.controlUrl}
                disabled={disabled}
                onChange={(event) => patch({ controlUrl: event.target.value })}
              />

              <PasswordInput
                label={t('network.accessKey')}
                hint={t('network.accessKeyHint')}
                value={value.authKey}
                disabled={disabled}
                onChange={(event) => patch({ authKey: event.target.value })}
              />
            </>
          ) : (
            <Select
              label={t('network.expose')}
              value={value.expose}
              disabled={disabled}
              onChange={(event) => patch({ expose: event.target.value as Expose })}
              options={[
                { value: 'tailnet', label: t('network.exposeTailnet') },
                { value: 'funnel', label: t('network.exposeFunnel') },
              ]}
            />
          )}

          <Select
            label={t('network.certStrategy')}
            value={value.certStrategy}
            disabled={disabled}
            onChange={(event) => patch({ certStrategy: event.target.value as CertStrategy })}
            options={[
              {
                value: 'control-plane',
                label: t('network.certControlPlane'),
                // Not merely unhelpful under Headscale — impossible. Offering it as a
                // selectable option would be offering a mode that can only ever fail.
                disabled: isCustom,
              },
              { value: 'external-proxy', label: t('network.certExternalProxy') },
              { value: 'dns01', label: t('network.certDns01') },
            ]}
          />

          {value.certStrategy !== 'control-plane' ? (
            <Input
              label={t('network.certDomain')}
              latin
              required
              placeholder="localcast.example.com"
              value={value.certDomain}
              disabled={disabled}
              onChange={(event) => patch({ certDomain: event.target.value })}
            />
          ) : null}

          {value.certStrategy === 'dns01' ? (
            <div className={styles.pair}>
              <Select
                label={t('network.dnsProvider')}
                placeholder={t('common.select')}
                value={value.dnsProvider}
                disabled={disabled}
                required
                onChange={(event) => patch({ dnsProvider: event.target.value as DnsProvider })}
                options={[
                  { value: 'cloudflare', label: 'Cloudflare' },
                  { value: 'digitalocean', label: 'DigitalOcean' },
                  { value: 'route53', label: 'Route 53' },
                  { value: 'gandi', label: 'Gandi' },
                ]}
              />
              <PasswordInput
                label={t('network.dnsApiToken')}
                hint={t('network.accessKeyHint')}
                required
                value={value.dnsApiToken}
                disabled={disabled}
                onChange={(event) => patch({ dnsApiToken: event.target.value })}
              />
            </div>
          ) : null}
        </div>

        {/* ── dry-run output ────────────────────────────────────────────────────── */}
        {testResult ? (
          <div className={styles.testResults} role="status" aria-live="polite">
            {testResult.messages.map((message, index) => (
              // The dry run returns an ordered list of prose lines with no ids; position is
              // the identity, and the whole list is replaced on every test.
              <p key={index} className={cx(styles.testMessage, styles[`level-${message.level}`])}>
                {message.level === 'info' ? <InfoIcon size={14} /> : <AlertIcon size={14} />}
                <span>{message.text}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
