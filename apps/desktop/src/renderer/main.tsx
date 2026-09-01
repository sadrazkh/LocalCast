import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '@localcast/ui-kit';
import '@localcast/ui-kit/tokens.css';
import './global.css';
import { FeedbackProvider } from './lib/feedback.js';
import { useRoute } from './lib/router.js';
import { PanelApp } from './panel/PanelApp.js';
import { ShellProvider } from './state/shell.js';
import { LibraryProvider } from './state/library.js';
import { TrayApp } from './tray/TrayApp.js';
import { Wizard } from './wizard/Wizard.js';

/**
 * One bundle, three windows.
 *
 * The main process opens the wizard, the panel and the tray popover at different hashes of
 * the same document, so they share a build, the design tokens and — importantly — one live
 * subscription each to the edge status stream. A separate entry point per window would mean
 * three bundles to keep in step for no gain.
 *
 * `ShellProvider` owns that subscription. It sits above the route switch so the tray popover
 * and the panel cannot disagree about whether the server is running.
 */
function Root() {
  const route = useRoute();

  switch (route.kind) {
    case 'wizard':
      return <Wizard />;
    case 'tray':
      return <TrayApp />;
    case 'panel':
      return <PanelApp section={route.section} />;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('renderer root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <LocaleProvider defaultLocale="fa">
      <FeedbackProvider>
        <ShellProvider>
          <LibraryProvider>
            <Root />
          </LibraryProvider>
        </ShellProvider>
      </FeedbackProvider>
    </LocaleProvider>
  </StrictMode>,
);
