import {
  CloudOffIcon,
  LibraryIcon,
  SearchIcon,
  ServerIcon,
  TabBar as KitTabBar,
  useT,
} from '@localcast/ui-kit';
import type { ConnectionState } from '@localcast/client-core';
import { navigate } from '../router.js';

/**
 * The bottom bar from the design canvas: کتابخانه / جست‌وجو / آفلاین / سرورها.
 *
 * A thin binding between the router and the presentational bar in `ui-kit` — the shared
 * component knows nothing about routes, and this file knows nothing about how a tab is
 * drawn.
 */

const TABS = ['library', 'search', 'offline', 'servers'] as const;
type TabId = (typeof TABS)[number];

const ROUTE_FOR: Record<TabId, string> = {
  library: '/library',
  search: '/search',
  offline: '/offline',
  servers: '/servers',
};

/** `/library/<folderId>?path=…` is still the library tab. */
function tabForPath(path: string): TabId {
  const head = path.split('/')[1] ?? '';
  return (TABS as readonly string[]).includes(head) ? (head as TabId) : 'library';
}

export interface TabBarProps {
  path: string;
  connection: ConnectionState;
}

export function TabBar({ path, connection }: TabBarProps) {
  // The four destination labels are shared with the desktop nav rail, so they live in the
  // ui-kit catalogue rather than being restated here.
  const t = useT();

  const items = [
    { id: 'library' as const, label: t('nav.library'), icon: <LibraryIcon /> },
    { id: 'search' as const, label: t('nav.search'), icon: <SearchIcon /> },
    {
      id: 'offline' as const,
      label: t('nav.offline'),
      icon: <CloudOffIcon />,
      // The only place the connection state reaches the bar: a dot over the offline tab
      // when that is where the user's files currently are. Still no transport detail.
      attention: connection === 'offline',
    },
    { id: 'servers' as const, label: t('nav.servers'), icon: <ServerIcon /> },
  ];

  return (
    <KitTabBar
      items={items}
      value={tabForPath(path)}
      onChange={(id) => navigate(ROUTE_FOR[id])}
      fixed
    />
  );
}
