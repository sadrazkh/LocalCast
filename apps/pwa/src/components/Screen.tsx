import type { ReactNode } from 'react';
import { ArrowBackIcon, Button, ConnectionDot, useT } from '@localcast/ui-kit';
import type { ConnectionState as DotState } from '@localcast/ui-kit';
import type { ConnectionState } from '@localcast/client-core';
import { navigate } from '../router.js';
import styles from './Screen.module.css';

/**
 * `client-core` and `ui-kit` name the middle state differently — `offline` against
 * `disconnected` — because one is describing the client and the other is describing a dot.
 * Translating in one function beats teaching either package about the other.
 */
export function toDotState(state: ConnectionState): DotState {
  return state === 'offline' ? 'disconnected' : state;
}

export interface ScreenProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Where the back arrow goes. Omit for a root tab. */
  back?: string;
  actions?: ReactNode;
  connection?: ConnectionState;
  /** Removes the body's padding for a full-bleed route. */
  flush?: boolean;
  children: ReactNode;
}

export function Screen({
  title,
  subtitle,
  back,
  actions,
  connection,
  flush = false,
  children,
}: ScreenProps) {
  const t = useT();

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        {back === undefined ? null : (
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            aria-label={t('common.back')}
            startIcon={<ArrowBackIcon />}
            onClick={() => navigate(back)}
          />
        )}
        <div className={styles.headerText}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle === undefined ? null : <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        <div className={styles.actions}>
          {actions}
          {connection === undefined ? null : (
            <ConnectionDot state={toDotState(connection)} showLabel={false} size="sm" />
          )}
        </div>
      </header>
      <div className={flush ? `${styles.body} ${styles.flush}` : styles.body}>{children}</div>
    </div>
  );
}
