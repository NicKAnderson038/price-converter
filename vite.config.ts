import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages project site: assets, manifest URLs, and the service worker
// scope must all resolve under /<repo>/.
const base = '/price-converter/'

// Same-origin OCR runtime assets. Derive the workbox matcher from `base` so a
// future base change cannot leave the runtime route pointing at a stale path.
const ocrUrlPattern = new RegExp(`${base}ocr/`)

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        id: base,
        name: 'Price Converter',
        short_name: 'Price Scan',
        description:
          'Scan a price and convert currencies, even offline with saved rates.',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#071B3C',
        theme_color: '#071B3C',
        icons: [
          {
            src: `${base}icons/icon-192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: `${base}icons/icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: `${base}icons/icon-512-maskable.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: `${base}icons/currency-scan-icon.svg`,
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Offline OCR assets are large and fetched on demand through the
        // CacheFirst runtime route below, never precached.
        globIgnores: ['**/ocr/**'],
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            urlPattern: ocrUrlPattern,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-assets',
              expiration: {
                maxEntries: 12,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
