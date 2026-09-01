import {
  ActivityIcon,
  ConnectionDot,
  FolderIcon,
  NavRail,
  PhoneIcon,
  QrIcon,
  ServerIcon,
  SettingsIcon,
  edgeStateToConnection,
  useFormat,
  useLocale,
  useT,
} from '@localcast/ui-kit';
import type { NavRailItem } from '@localcast/ui-kit';
import { AddressField } from '../components/AddressField.js';
import { TitleBar } from '../components/TitleBar.js';
import { useCopy } from '../lib/copy.js';
import { navigate } from '../lib/router.js';
import { PreflightBanner } from '../preflight/index.js';
import type { PanelSection } from '../lib/router.js';
import { LibraryProvider, useLibrary } from '../state/library.js';
import { useShell } from '../state/shell.js';
import { ActivityScreen } from './ActivityScreen.js';
import { DevicesScreen } from './DevicesScreen.js';
import { FoldersScreen } from './FoldersScreen.js';
import { HostingScreen } from './HostingScreen.js';
import { PairingScreen } from './PairingScreen.js';
import { SettingsScreen } from './SettingsScreen.js';
import styles from './PanelApp.module.css';

/**
 * The operator panel: a navigation rail and one screen at a time, drawn at the canvas's
 * 1000×640.
 *
 * The header carries two things that are deliberately separate. The **indicator** is a dot
 * and a word — «متصل», «قطع», «در حال تلاش» — and nothing else; no address, no relay, no
 * protocol. The **address** is its own labelled field with a copy button, because the
 * operator genuinely needs to read and copy it. Collapsing the two, which is what almost
 * every app does, is how transport detail ends up as decoration next to a status light.
 */
export function PanelApp({ section }: { section: PanelSection }) {
  return (
    <LibraryProvider>
      <PanelShell section={section} />
    </LibraryProvider>
  );
}

function PanelShell({ section }: { section: PanelSection }) {
  const t = useT();
  const c = useCopy();
  const format = useFormat();
  const { locale } = useLocale();
  const { status } = useShell();
  const { folders, devices } = useLibrary();

  const pending = devices.filter((device) => device.status === 'pending').length;

  const items: NavRailItem<PanelSection>[] = [
    { id: 'hosting', label: c('shell.nav.hosting'), icon: <ServerIcon size={16} /> },
    {
      id: 'folders',
      label: t('nav.sharedFolders'),
      icon: <FolderIcon size={16} />,
      count: folders.length > 0 ? format.count(folders.length) : undefined,
    },
    {
      id: 'devices',
      label: t('nav.devices'),
      icon: <PhoneIcon size={16} />,
      // The badge counts devices waiting for approval, not devices in total: the total is
      // information, a pending approval is a job.
      count: pending > 0 ? format.count(pending) : undefined,
    },
    { id: 'pairing', label: t('nav.qrPairing'), icon: <QrIcon size={16} /> },
    { id: 'settings', label: t('nav.settings'), icon: <SettingsIcon size={16} /> },
    { id: 'activity', label: t('nav.activity'), icon: <ActivityIcon size={16} /> },
  ];

  return (
    <div className={styles.window} lang={locale}>
      <TitleBar>
        <ConnectionDot state={edgeStateToConnection(status?.state ?? 'starting')} />
        <AddressField host={status?.host ?? null} />
      </TitleBar>

      <div className={styles.split}>
        <NavRail<PanelSection>
          items={items}
          value={section}
          onChange={(id) => navigate(`/panel/${id}`)}
          className={styles.rail}
        />
        <main className={styles.content}>
          {/*
            The way back from "ادامه بدون این". A user who dismissed a degrading prerequisite
            during setup would otherwise have no route to printing ever working, since the
            wizard never runs again.
          */}
          <PreflightBanner />
          {section === 'hosting' ? <HostingScreen /> : null}
          {section === 'folders' ? <FoldersScreen /> : null}
          {section === 'devices' ? <DevicesScreen /> : null}
          {section === 'pairing' ? <PairingScreen /> : null}
          {section === 'settings' ? <SettingsScreen /> : null}
          {section === 'activity' ? <ActivityScreen /> : null}
        </main>
      </div>
    </div>
  );
}
