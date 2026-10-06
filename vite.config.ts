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
  resolve: {
    // onnxruntime-web@1.30.0 exposes each browser entry point through a
    // conditional `exports` map. For the `./wasm` subpath:
    //
    //   "import": {
    //     "onnxruntime-web-use-extern-wasm": "./dist/ort.wasm.min.mjs",
    //     "default": "./dist/ort.wasm.bundle.min.mjs"
    //   }
    //
    // The default (`*.bundle`) references the wasm binary via
    // `new URL('ort-wasm-simd-threaded.wasm', import.meta.url)`, which Vite
    // resolves and emits as a duplicate ~14 MB `dist/assets/*.wasm`. The extern
    // build loads the same-origin copy under `public/ocr/ort/` at runtime via
    // `env.wasm.wasmPaths` and marks its glue import `/*@vite-ignore*/`, so Vite
    // leaves it alone. Enabling the custom condition selects `ort.wasm.min.mjs`.
    //
    // Vite REPLACES the default client conditions when `resolve.conditions` is
    // set, so the defaults (`module`, `browser`, `development|production`) are
    // re-listed here to keep package resolution otherwise unchanged.
    conditions: [
      'module',
      'browser',
      'development|production',
      'onnxruntime-web-use-extern-wasm',
    ],
  },
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
