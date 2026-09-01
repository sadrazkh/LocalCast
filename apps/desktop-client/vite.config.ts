import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'src/renderer');
const workspace = resolve(import.meta.dirname, '../..');

/**
 * Builds only the renderer. The main process and the preload script are compiled by
 * `tsc -p tsconfig.node.json`: they run in Node and in Electron's preload sandbox, and a
 * stack trace that points at the real file is worth more there than a smaller bundle.
 *
 * The workspace packages are aliased to their **sources** rather than their built `dist`
 * output. That is not a convenience: `@localcast/ui-kit` is compiled with `tsc`, which emits
 * JavaScript and type declarations but does not copy `*.module.css` — so a `dist` build of a
 * component still imports a stylesheet that only exists in `src`. Pointing at the source also
 * means a change in the kit is visible here without a rebuild.
 */
export default defineConfig(({ command }) => ({
  root,
  base: './',
  plugins: [
    react(),
    {
      name: 'localcast-dev-csp',
      transformIndexHtml(html: string) {
        // The shipped CSP forbids the renderer from opening any connection of its own —
        // every network call in this app happens in the main process. Vite's dev client
        // needs one websocket back to the server, so the rule is relaxed in `vite dev` only
        // and the production build keeps `connect-src 'none'`.
        if (command !== 'serve') return html;
        return html.replace("connect-src 'none'", "connect-src 'self' ws://localhost:5175");
      },
    },
  ],
  resolve: {
    alias: {
      '@localcast/ui-kit/tokens.css': resolve(workspace, 'packages/ui-kit/src/tokens.css'),
      '@localcast/ui-kit': resolve(workspace, 'packages/ui-kit/src/index.ts'),
      '@localcast/client-core': resolve(workspace, 'packages/client-core/src/index.ts'),
      '@localcast/contract': resolve(workspace, 'packages/contract/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Electron 33 ships Chromium 130; nothing here needs to be transpiled below it.
    target: 'chrome128',
    sourcemap: true,
  },
  // A different port from the server app's, so both can run in development at once.
  server: { port: 5175, strictPort: true },
}));
