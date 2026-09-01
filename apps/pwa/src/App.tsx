import { useEffect } from 'react';
import { Spinner } from '@localcast/ui-kit';
import { useClientContext, useConnectionState } from './client/ClientProvider.js';
import { navigate, useRoute } from './router.js';
import { TabBar } from './components/TabBar.js';
import { LibraryRoute } from './routes/LibraryRoute.js';
import { OfflineRoute } from './routes/OfflineRoute.js';
import { PairRoute } from './routes/PairRoute.js';
import { PlayerRoute } from './routes/PlayerRoute.js';
import { SearchRoute } from './routes/SearchRoute.js';
import { ServersRoute } from './routes/ServersRoute.js';
import { UploadRoute } from './routes/UploadRoute.js';
import type { QrDecoder } from './hooks/useQrScanner.js';
import styles from './App.module.css';

/** Routes that own the whole screen: the tab bar would be in the way, or meaningless. */
const FULL_SCREEN = new Set(['/pair']);

export interface AppProps {
  /** `jsQR`, injected so the pairing screen can be tested without a camera or a decoder. */
  decode?: QrDecoder;
}

export function App({ decode }: AppProps) {
  const route = useRoute();
  const { session, ready } = useClientContext();
  const connection = useConnectionState();

  const isPairing = route.path === '/pair';

  useEffect(() => {
    if (!ready) return;
    // The auth gate. Redirect rather than render pairing in place, so the address bar and the
    // back gesture agree with what is on screen — an installed PWA restores its last URL on
    // launch, and landing on `#/play/abc` unpaired must not leave that hash behind.
    if (session === null && !isPairing) navigate('/pair', { replace: true });
    if (session !== null && isPairing) navigate('/library', { replace: true });
  }, [ready, session, isPairing]);

  if (!ready) {
    return (
      <div className={styles.splash}>
        <Spinner size="lg" labelled />
      </div>
    );
  }

  const showTabBar = !FULL_SCREEN.has(route.path) && session !== null && !route.path.startsWith('/play/');

  return (
    <div className={styles.app}>
      <div className={styles.route}>{renderRoute(route.segments, route.query, decode)}</div>
      {showTabBar ? <TabBar path={route.path} connection={connection} /> : null}
    </div>
  );
}

function renderRoute(
  segments: readonly string[],
  query: URLSearchParams,
  decode: QrDecoder | undefined,
) {
  const [head, second] = segments;

  switch (head) {
    case 'pair':
      return <PairRoute {...(decode === undefined ? {} : { decode })} />;
    case 'play':
      // No id means somebody hand-edited the hash; the library is the honest destination.
      return second === undefined ? <LibraryRoute folderId={null} path="" /> : <PlayerRoute fileId={second} />;
    case 'search':
      return <SearchRoute />;
    case 'offline':
      return <OfflineRoute />;
    case 'servers':
      return <ServersRoute view={second === 'network' ? 'network' : second === 'remote' ? 'remote' : ''} />;
    case 'upload':
      return <UploadRoute />;
    case 'library':
    default:
      return <LibraryRoute folderId={second ?? null} path={query.get('path') ?? ''} />;
  }
}
