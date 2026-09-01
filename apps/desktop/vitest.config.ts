import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: [resolve(import.meta.dirname, 'src/renderer/test/setup.ts')],
  },
});
