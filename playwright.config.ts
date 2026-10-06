import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright end-to-end config (T8).
 *
 * The focused suite runs against the **production build** served at the same
 * base path as the GitHub Pages deployment (`/price-converter/`), via
 * `vite preview`. `e2e/global-setup.ts` asserts `dist/` is present first, so
 * the intended flow is:
 *
 *   npm run build && npm run test:e2e
 */

const BASE_PATH = '/price-converter/'
const PORT = 4173
const BASE_URL = `http://localhost:${PORT}${BASE_PATH}`

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  globalSetup: './e2e/global-setup.ts',

  // Keep the suite small and deterministic: files run in parallel workers, but
  // tests inside a file stay in order (shared offline/SW state).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],

  expect: {
    timeout: 7_000,
  },

  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    // Provider mocking (page.route) must not race the service worker's own
    // fetch handler. The dedicated service-worker spec opts back in with
    // `test.use({ serviceWorkers: 'allow' })`.
    serviceWorkers: 'block',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  webServer: {
    // Serve the already-built dist/ at the Pages base path. `vite preview`
    // reads `base` from vite.config.ts, so /price-converter/ is the root.
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
