import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  CloudOffIcon,
  EmptyState,
  FolderIcon,
  SectionHeader,
  formatBytes,
  formatCount,
  useLocale,
  useT,
} from '@localcast/ui-kit';
import { SSE_BACKOFF, backoffDelay } from '@localcast/client-core';
import { folderSchema } from '@localcast/contract';
import type { Folder } from '@localcast/contract';
import { useClient, useConnectionState } from '../client/ClientProvider.js';
import { useAppT } from '../i18n/messages.js';
import { buildHref } from '../router.js';
import { Screen } from '../components/Screen.js';
import styles from './OfflineRoute.module.css';
import libraryStyles from './LibraryRoute.module.css';

const foldersSchema = folderSchema.array();

/**
 * Screen 11 — offline.
 *
 * The list here is read straight out of the cache and is never fetched. That is the point of
 * the screen: it answers "what do I still have?" while the server is unreachable, and a
 * request in flight behind it would make the answer flicker between "this is what is saved"
 * and "this is what exists".
 *
 * The retry ladder is the same `SSE_BACKOFF` the event stream uses, so the countdown on
 * screen and the reconnection actually happening underneath are the same schedule rather than
 * two that drift apart.
 */
export function OfflineRoute() {
  const t = useT();
  const at = useAppT();
  const { locale } = useLocale();
  const client = useClient();
  const connection = useConnectionState();

  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      if (client.cache === null) {
        if (live) setFolders([]);
        return;
      }
      // `read` rather than `withCache`: no fetcher, no network, whatever is saved.
      const cached = await client.cache.read('folders', 'all', foldersSchema);
      if (live) setFolders(cached?.value ?? []);
    })();
    return () => {
      live = false;
    };
  }, [client]);

  // Count down to the next automatic attempt, and take the ladder back to the bottom the
  // moment the connection returns.
  useEffect(() => {
    if (connection === 'connected') {
      attempt.current = 0;
      setSecondsLeft(null);
      return;
    }
    let cancelled = false;
    // No jitter in the displayed number: a countdown that jumps looks broken even though the
    // jitter underneath is correct and deliberate.
    const delayMs = backoffDelay(attempt.current, { ...SSE_BACKOFF, jitter: 0 }, () => 0.5);
    let remaining = Math.round(delayMs / 1_000);
    setSecondsLeft(remaining);

    const timer = setInterval(() => {
      remaining -= 1;
      if (cancelled) return;
      if (remaining <= 0) {
        attempt.current += 1;
        void probe();
        setSecondsLeft(null);
        clearInterval(timer);
        return;
      }
      setSecondsLeft(remaining);
    }, 1_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, client]);

  async function probe(): Promise<void> {
    // `me` is the cheapest authenticated round trip there is, and its outcome feeds the
    // connection monitor through `ApiClient.onOutcome` — so a success flips the dot green
    // without this screen deciding anything about connection state itself.
    await client.api.me().catch(() => undefined);
  }

  const dotClass =
    connection === 'connected'
      ? `${styles.dot} ${styles.dotOnline}`
      : connection === 'connecting'
        ? `${styles.dot} ${styles.dotTrying}`
        : styles.dot;

  return (
    <Screen title={t('nav.offline')} connection={connection}>
      <div className={styles.banner}>
        <span className={dotClass} data-testid="offline-dot" data-state={connection} />
        <div className={styles.text}>
          <p className={styles.title}>
            {connection === 'connected' ? at('offlineScreen.connectedAgain') : t('offline.title')}
          </p>
          <p className={styles.body}>
            {connection === 'connected' ? at('offlineScreen.savedLibrary') : t('offline.body')}
          </p>
          {connection === 'connected' ? null : (
            <div className={styles.countdown}>
              {secondsLeft === null ? (
                <span>{at('app.reconnecting')}</span>
              ) : (
                // A countdown is a count, so it takes the locale's digits — the ASCII rule is
                // for addresses, byte sizes and codes, none of which this is.
                <span>{at('offlineScreen.retryIn', { seconds: formatCount(secondsLeft, locale) })}</span>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  attempt.current = 0;
                  void probe();
                }}
              >
                {at('offlineScreen.retryNow')}
              </Button>
            </div>
          )}
        </div>
      </div>

      <SectionHeader
        small
        ruled
        className={styles.section}
        title={at('offlineScreen.savedLibrary')}
        count={folders === null ? undefined : formatCount(folders.length, locale)}
      />

      {folders === null ? null : folders.length === 0 ? (
        <EmptyState
          icon={<CloudOffIcon size={28} />}
          title={at('offlineScreen.nothingSaved')}
          description={at('offlineScreen.nothingSavedHint')}
        />
      ) : (
        <div className={styles.folders}>
          {folders.map((folder) => (
            <Card key={folder.id} padding="sm" muted={!folder.available}>
              <a
                className={libraryStyles.folderCard}
                href={buildHref(`/library/${encodeURIComponent(folder.id)}`)}
                data-testid={`offline-folder-${folder.id}`}
              >
                <span className={libraryStyles.folderIcon}>
                  <FolderIcon size={22} />
                </span>
                <span className={libraryStyles.folderText}>
                  <span className={libraryStyles.folderLabel}>{folder.label}</span>
                  <span className={libraryStyles.folderMeta}>
                    {folder.fileCount === null ? null : (
                      <span>{formatCount(folder.fileCount, locale)}</span>
                    )}
                    {folder.totalBytes === null ? null : (
                      <span className={libraryStyles.mono}>{formatBytes(folder.totalBytes)}</span>
                    )}
                  </span>
                </span>
              </a>
            </Card>
          ))}
        </div>
      )}
    </Screen>
  );
}
