import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The package's tsconfig sets `jsx: react-jsx`, but esbuild only picks that up when it
  // resolves the right tsconfig for every file. Stating it here removes the guesswork.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    // `globals` is what lets @testing-library/react register its own `afterEach(cleanup)`.
    // Without it every test would leak its DOM into the next one.
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // CSS Modules are left unprocessed: `styles.foo` resolves to a proxy at test time, and
    // nothing here asserts on generated class names. The RTL test reads the CSS as source
    // text instead, which is the honest way to check a stylesheet rule.
    css: false,
    restoreMocks: true,
  },
});
