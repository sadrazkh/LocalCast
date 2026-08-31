import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Builds only the renderer. The main process and the preload script are compiled by
 * `tsc -p tsconfig.node.json`, because they run in Node and Electron respectively and have
 * nothing to gain from bundling — a stack trace that points at the real file is worth more
 * here than a few hundred kilobytes.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
  },
  server: { port: 5174, strictPort: true },
});
