import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon-180.png', 'icons/favicon-32.png'],
      manifest: {
        id: '/',
        name: 'LocalCast',
        short_name: 'LocalCast',
        description: 'اشتراک فایل، پخش ویدیو و چاپ از راه دور',
        lang: 'fa',
        dir: 'rtl',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        background_color: '#0d0e12',
        theme_color: '#0d0e12',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is precached so the library opens instantly and shows its offline
        // state rather than a browser error page when the server is unreachable.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // A 20 GB film must never enter the cache, and a range request served from a cached
        // 200 response would break seeking outright. Media, WebDAV and the API are all
        // excluded from the service worker entirely; freshness there is client-core's job.
        navigateFallbackDenylist: [/^\/api\//, /^\/dav\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/v1\/(folders|me)(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'lc-library-shell',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    // In development the PWA talks to a server started by the Electron app on loopback.
    // LOCALCAST_DEV_API is written by `apps/desktop` when it boots in dev mode.
    proxy: {
      '/api': { target: process.env.LOCALCAST_DEV_API ?? 'http://127.0.0.1:8420', changeOrigin: true },
      '/dav': { target: process.env.LOCALCAST_DEV_API ?? 'http://127.0.0.1:8420', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The PWA is served by the Node server from apps/server's static root.
    outDir: 'dist',
  },
});
