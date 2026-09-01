import { useEffect, useState } from 'react';
import { EmptyState, Input, SearchIcon, Spinner, useLocale, useT } from '@localcast/ui-kit';
import type { Entry } from '@localcast/contract';
import { useApi, useConnectionState } from '../client/ClientProvider.js';
import { useAppT } from '../i18n/messages.js';
import { buildHref } from '../router.js';
import { FileListRow } from '../components/FileListRow.js';
import { Screen } from '../components/Screen.js';
import listStyles from '../components/FileListRow.module.css';

/**
 * Full-text search over the folders this device may list.
 *
 * Deliberately never served from the offline cache. `CACHE_POLICIES.search` says
 * `staleWhileOffline: false`, and the reason is written down there: an offline search runs
 * against whatever listings happen to be cached and returns *fewer* results than exist, which
 * the user reads as "my file is gone". An honest empty state beats a quietly incomplete answer.
 */
export function SearchRoute() {
  const t = useT();
  const at = useAppT();
  const api = useApi();
  const { locale } = useLocale();
  const connection = useConnectionState();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    // Debounced, because FTS5 across a large index is not free and a Persian keyboard emits a
    // keystroke per composed character.
    const timer = setTimeout(() => {
      setLoading(true);
      void api
        .search(trimmed, { signal: controller.signal })
        .then((response) => setResults(response.results))
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause);
          setResults([]);
        })
        .finally(() => setLoading(false));
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, locale]);

  return (
    <Screen title={t('nav.search')} connection={connection}>
      <Input
        label={t('common.search')}
        type="search"
        inputMode="search"
        startAdornment={<SearchIcon size={16} />}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        data-testid="search-input"
      />

      {loading ? (
        <Spinner labelled />
      ) : results === null ? null : results.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={28} />}
          title={t('table.empty')}
          description={error === null ? undefined : String(messageOf(error))}
        />
      ) : (
        <div className={listStyles.list}>
          {results.map((entry) => (
            <FileListRow
              key={entry.id}
              entry={entry}
              href={
                entry.isDir
                  ? buildHref(`/library/${encodeURIComponent(entry.folderId)}`, { path: entry.path })
                  : buildHref(`/play/${encodeURIComponent(entry.id)}`)
              }
            />
          ))}
        </div>
      )}

      {connection === 'offline' && results === null ? (
        <EmptyState title={t('offline.title')} description={at('offlineScreen.nothingSavedHint')} />
      ) : null}
    </Screen>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
