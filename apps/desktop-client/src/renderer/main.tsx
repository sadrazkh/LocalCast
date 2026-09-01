import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '@localcast/ui-kit';
import '@localcast/ui-kit/tokens.css';
import { App } from './App.js';
import { BridgeProvider } from './bridge.js';
import './global.css';

/**
 * Renderer entry point.
 *
 * `LocaleProvider` renders the `.lc-root` element the design tokens are scoped to and sets
 * `lang`/`dir` on the document, which is what makes the whole surface RTL without a single
 * per-component override.
 */
const container = document.getElementById('root');
if (container === null) throw new Error('the renderer root element is missing');

createRoot(container).render(
  <StrictMode>
    <LocaleProvider defaultLocale="fa">
      <BridgeProvider>
        <App />
      </BridgeProvider>
    </LocaleProvider>
  </StrictMode>,
);
