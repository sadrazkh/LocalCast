import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');

/**
 * Tests run in `jsdom` by default, because most of what is worth asserting here is what a
 * screen renders. The main-process suites — the session vault, the client hub, the download
 * queue — opt into `node` with a `@vitest-environment node` docblock, since they touch `fs`
 * and want real `ReadableStream` semantics rather than jsdom's.
 *
 * Nothing under test imports `electron`. That is a design constraint, not a lucky accident:
 * `SessionVault` takes a `SecretCodec`, `MainHttpTransport` takes a `fetch`, and `ClientHub`
 * takes a transport and a clock — so every one of them can be driven from a plain Node
 * process. The three modules that do import Electron (`secrets`, `windows`, `ipc`) contain
 * only wiring.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Same reasoning as vite.config.ts: the kit's `dist` has no stylesheets in it.
      '@localcast/ui-kit/tokens.css': resolve(workspace, 'packages/ui-kit/src/tokens.css'),
      '@localcast/ui-kit': resolve(workspace, 'packages/ui-kit/src/index.ts'),
      '@localcast/client-core': resolve(workspace, 'packages/client-core/src/index.ts'),
      '@localcast/contract': resolve(workspace, 'packages/contract/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    css: false,
    restoreMocks: true,
  },
});
