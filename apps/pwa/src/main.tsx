import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import jsQR from 'jsqr';
import { LocaleProvider } from '@localcast/ui-kit';
import '@localcast/ui-kit/tokens.css';
import './styles/global.css';
import { App } from './App.js';
import { ClientProvider } from './client/ClientProvider.js';

/**
 * Entry point.
 *
 * `jsQR` is imported here and passed down rather than imported by the pairing screen, so the
 * decoder is an injected dependency everywhere below this line — which is what lets the
 * pairing flow be tested without a camera, and what keeps a 40 kB decoder out of the module
 * graph of every screen that is not the pairing screen.
 */
const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <LocaleProvider defaultLocale="fa">
      <ClientProvider>
        <App decode={(data, width, height) => jsQR(data, width, height, { inversionAttempts: 'dontInvert' })} />
      </ClientProvider>
    </LocaleProvider>
  </StrictMode>,
);

registerServiceWorker();

/**
 * Register the worker that puts the bearer on media requests.
 *
 * `virtual:pwa-register` is provided by `vite-plugin-pwa` and registers whichever `sw.js` the
 * build produced. Note what that means today: the plugin is configured with the default
 * `generateSW` strategy, which emits Workbox's own worker and **ignores `src/sw.ts`**. For
 * the auth injection in `src/sw.ts` to actually ship, `apps/pwa/vite.config.ts` needs
 * `strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts'` — that file is outside
 * this app's ownership, so the change is reported rather than made. Everything on this side
 * is written for it.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true });
    })
    .catch(() => {
      // A build without the plugin (a plain `vite dev`, a test harness) simply has no worker.
      // Playback then fails on a 401 rather than silently — which is the right way round.
    });
}
