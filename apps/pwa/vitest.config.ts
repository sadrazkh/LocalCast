import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Rendering assertions need real element APIs; the service-worker tests only need
    // Request/Response/Headers, which jsdom provides through undici.
    globals: false,
    restoreMocks: true,
  },
});
