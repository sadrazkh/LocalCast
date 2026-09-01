import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      /**
       * injectManifest, not generateSW.
       *
       * The whole reason this app has a service worker is that `<video src>` cannot send an
       * Authorization header, so `src/sw.ts` attaches it to media and WebDAV requests. A
       * generated Workbox worker cannot express that, and — worse — it installs happily and
       * silently, so the symptom is video that 401s while everything else looks fine.
       */
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
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
      injectManifest: {
        // The app shell is precached so the library opens instantly and shows its offline
        // state rather than a browser error page when the server is unreachable.
        //
        // A 20 GB film must never enter the cache: a Range request answered from a cached
        // 200 is a full body where 206 was expected, and Safari's response to that is an
        // unseekable timeline. Media and WebDAV are handled by src/sw/media.ts, which caches
        // nothing at all; routing and freshness for the API are client-core's job.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        // 3 MB. The shell is ~660 KB today; this is a ceiling that trips if a build ever
        // starts precaching something it should not.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
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
