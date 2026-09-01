import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // The main-process tests carry `@vitest-environment node`, so the jsdom default above is
    // the renderer's and only the renderer's.
    include: ['src/renderer/**/*.test.{ts,tsx}', 'src/main/**/*.test.ts'],
    restoreMocks: true,
    setupFiles: [resolve(import.meta.dirname, 'src/renderer/test/setup.ts')],
  },
});
