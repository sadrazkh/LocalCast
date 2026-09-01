import type { EdgeState } from '@localcast/contract';
import { useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { cx } from '../utils/cx.js';
import styles from './ConnectionDot.module.css';

/**
 * The only thing the dot knows.
 *
 * Three values, no host, no address, no relay, no protocol. The spec is explicit that
 * transport detail must never appear next to the indicator, and the cheapest way to
 * guarantee that is to make it impossible to pass in — this component takes no `host`,
 * no `endpoint` and no `detail` prop, and there is deliberately no `label` override.
 */
export type ConnectionState = 'connected' | 'disconnected' | 'connecting';

const LABEL_KEY: Record<ConnectionState, MessageKey> = {
  connected: 'connection.connected',
  disconnected: 'connection.disconnected',
  connecting: 'connection.connecting',
};

/**
 * Collapses the seven-state `EdgeState` from the contract down to the three the dot shows.
 *
 * `login-required` and `obtaining-certificate` are amber rather than red: they are states
 * the operator can still act on, and the settings panel spells them out in full. Only a
 * stopped or errored edge is «قطع».
 */
export function edgeStateToConnection(state: EdgeState): ConnectionState {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'stopped':
    case 'error':
      return 'disconnected';
    case 'starting':
    case 'connecting':
    case 'login-required':
    case 'obtaining-certificate':
      return 'connecting';
    default:
      return 'disconnected';
  }
}

export interface ConnectionDotProps {
  state: ConnectionState;
  /** Renders «متصل» / «قطع» / «در حال تلاش» beside the dot. */
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The connection indicator from the tray and from the top of every mobile screen.
 *
 * Green «متصل», red «قطع», amber «در حال تلاش». When the label is hidden the state is still
 * announced through `role="status"` and a visually-hidden text node, because colour alone is
 * not a status for anyone using a screen reader or unable to separate red from green.
 */
export function ConnectionDot({
  state,
  showLabel = true,
  size = 'md',
  className,
}: ConnectionDotProps) {
  const t = useT();
  const label = t(LABEL_KEY[state]);

  return (
    <span
      className={cx(styles.wrapper, className)}
      role="status"
      aria-label={t('connection.label')}
    >
      <span className={cx(styles.dot, styles[size], styles[state])} aria-hidden="true" />
      {showLabel ? (
        <span className={styles.label}>{label}</span>
      ) : (
        <span className="lc-sr-only">{label}</span>
      )}
    </span>
  );
}
