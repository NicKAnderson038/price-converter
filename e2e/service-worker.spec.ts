import { test, expect } from '@playwright/test'
import { RATES_KEY, RATES_FIXTURE_DATE_LABEL, savedSnapshot } from './fixtures/rates'

const APP_PATH = '/price-converter/'
const APP_URL = `http://localhost:4173${APP_PATH}`

/**
 * The real service worker, driven end to end: the SW installs for real, the
 * shell is served from its precache, and offline emulation is genuine, so the
 * cached-conversion path is exercised as shipped rather than stubbed.
 *
 * The provider request is still explicitly aborted with `context.route` (added
 * with the other routes at the top of each test). This does not fake the
 * offline behavior — it pins it. A stale seeded snapshot triggers the app's
 * automatic refresh, and if the provider is reachable that live response
 * overwrites the seeded snapshot (it can be reachable in CI even under
 * `setOffline`). Aborting the provider makes the offline-fallback assertion
 * deterministic on any network, while the SW/offline mechanics remain
 * end-to-end.
 */
test.describe('service worker offline', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service worker inspection/offline emulation is Chromium-only',
  )

  test('online visit activates the SW, then an offline reload serves the shell and a cached conversion', async ({
    browser,
  }) => {
    const context = await browser.newContext({ serviceWorkers: 'allow', locale: 'en-US' })
    const page = await context.newPage()

    try {
      // Abort the provider up front so the app's automatic refresh can never
      // replace the seeded stale snapshot, even when CI can reach the network
      // under `setOffline`. The seeded snapshot must survive the offline reload.
      await context.route(/api\.frankfurter\.dev/, (route) =>
        route.abort('internetdisconnected'),
      )

      await page.goto(`${APP_URL}?base=EUR&target=USD&amount=100`)

      // Wait for the generated SW to install and activate.
      const registration = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready
        return { scope: reg.scope, active: reg.active !== null }
      })
      expect(registration.active).toBe(true)
      expect(registration.scope).toBe(APP_URL)

      // Reload once online so the document is definitely SW-controlled.
      await page.reload()
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)

      // Seed a saved snapshot so the offline reload can convert from cache.
      const fetchedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
      await context.addInitScript(
        ({ key, snapshot }) => {
          localStorage.setItem(key, JSON.stringify(snapshot))
        },
        { key: RATES_KEY, snapshot: savedSnapshot(fetchedAt) },
      )

      await context.setOffline(true)
      await page.reload()

      // Shell still loads...
      await expect(page.getByRole('heading', { name: 'Price Converter' })).toBeVisible()
      // ...and the cached conversion is still available.
      await expect(page.getByTestId('result')).toHaveAttribute('data-raw-value', '125')

      const badge = page.getByTestId('status-badge')
      await expect(badge).toHaveAttribute('data-status', 'offline')
      await expect(badge).toContainText(RATES_FIXTURE_DATE_LABEL)
    } finally {
      await context.close()
    }
  })

  test('fresh context with the provider unreachable shows the first-use offline message', async ({
    browser,
  }) => {
    const context = await browser.newContext({ serviceWorkers: 'allow', locale: 'en-US' })
    const page = await context.newPage()

    try {
      // Environment limitation: Playwright's `setOffline(true)` blocks the local
      // preview origin too, and a brand-new context has no SW/cache, so the
      // shell cannot load at all. That is not an app defect. We reproduce the
      // genuine first-use-offline *state* (no saved snapshot + provider
      // unreachable) with a network-blocking route while the local shell loads.
      await context.route(/api\.frankfurter\.dev/, (route) =>
        route.abort('internetdisconnected'),
      )

      await page.goto(APP_URL)

      const badge = page.getByTestId('status-badge')
      await expect(badge).toHaveAttribute('data-status', 'no-cache')
      await expect(badge).toContainText('No saved rates')
      await expect(badge).toContainText('first conversion needs a connection')

      await expect(
        page.getByText('No saved rates yet — the first conversion needs a connection.'),
      ).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
