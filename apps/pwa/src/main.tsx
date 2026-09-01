import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import jsQR from 'jsqr';
import { LocaleProvider } from '@localcast/ui-kit';
import '@localcast/ui-kit/tokens.css';
import './styles/global.css';
import { App } from './App.js';
import { capabilityStore } from './capabilities/store.js';
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
 * Register the worker that puts the bearer on media requests, and record what happened.
 *
 * `virtual:pwa-register` is provided by `vite-plugin-pwa`, which is configured with
 * `strategies: 'injectManifest'` and therefore ships `src/sw.ts` itself rather than a
 * generated Workbox worker — the auth injection is the whole reason this app has a worker at
 * all, and a generated one cannot express it.
 *
 * The outcome is written into the capability store, and this is the load-bearing part. On the
 * local network the origin carries a certificate the browser was asked to accept, and browsers
 * differ on what they will grant such an origin: Chrome is documented to refuse service-worker
 * registration outright, and Safari on iOS has never been checked. That difference is the
 * difference between having an offline library and not having one, and until now the app
 * assumed rather than looked. Now it looks, says so on its own settings screen, and tells the
 * server so the Windows panel can say it too.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onRegisteredSW: () => capabilityStore.noteServiceWorker({ ok: true }),
        // This is the callback that fires on a refusal. Its argument is the browser's own
        // error, and only its `name` is ever kept.
        onRegisterError: (error: unknown) => capabilityStore.noteServiceWorker({ ok: false, error }),
      });
    })
    .catch(() => {
      // A build without the plugin (a plain `vite dev`, a test harness) simply has no worker.
      // Playback then fails on a 401 rather than silently — which is the right way round. The
      // capability store is deliberately left `pending`: nothing was refused here, the build
      // just did not ship a worker, and reporting a refusal would be a lie about the browser.
    });
}
