import { test, expect } from '@playwright/test'
import { PREFS_KEY } from './fixtures/rates'

const APP = '/price-converter/'

test.describe('settings + URL precedence', () => {
  test('a new primary currency in Settings persists across reloads', async ({ page }) => {
    await page.goto(APP)

    // Settings is its own view now: reach it through the header gear.
    await page.getByTestId('open-settings').click()
    const primary = page.getByTestId('primary-currency-select')
    await expect(primary).toBeVisible()

    await primary.selectOption('JPY')

    // Persisted immediately through the storage module.
    const stored = await page.evaluate((key) => localStorage.getItem(key), PREFS_KEY)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string).primaryCurrency).toBe('JPY')

    // `?view=settings` is kept in the URL, so the reload stays on Settings.
    await page.reload()
    await expect(page.getByTestId('primary-currency-select')).toHaveValue('JPY')

    // Still selected on a clean navigation with no URL hint.
    await page.goto(APP)
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('primary-currency-select')).toHaveValue('JPY')
  })

  test('a URL override controls the visit without replacing saved preferences', async ({ page }) => {
    // Seed a saved preference (via storage) that differs from the URL pair.
    await page.goto(APP)
    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      { key: PREFS_KEY, value: { schemaVersion: 1, primaryCurrency: 'GBP', targetCurrency: 'USD' } },
    )

    await page.goto(`${APP}?base=EUR&target=USD&amount=12.50`)

    await expect(page.getByTestId('converter-base-select')).toHaveValue('EUR')
    await expect(page.getByTestId('converter-target-select')).toHaveValue('USD')
    await expect(page.getByTestId('amount-input')).toHaveValue('12.50')

    // The visit must not rewrite the saved primary.
    const stored = await page.evaluate((key) => localStorage.getItem(key), PREFS_KEY)
    expect(JSON.parse(stored as string).primaryCurrency).toBe('GBP')

    // A parameterless reload still loads the saved primary: the converter shows
    // GBP, and Settings reports it as the saved primary.
    await page.goto(APP)
    await expect(page.getByTestId('converter-base-select')).toHaveValue('GBP')
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('primary-currency-select')).toHaveValue('GBP')
  })
})

test.describe('view navigation (query-param view, no router)', () => {
  test('the gear opens Settings, the URL carries view=settings, and the home icon removes it', async ({
    page,
  }) => {
    await page.goto(APP)

    // Home shows the converter and never the Settings controls.
    await expect(page.getByTestId('converter-base-select')).toBeVisible()
    await expect(page.getByTestId('primary-currency-select')).toHaveCount(0)

    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('primary-currency-select')).toBeVisible()
    await expect(page.getByTestId('converter-base-select')).toHaveCount(0)
    await expect(page).toHaveURL(/[?&]view=settings/)

    // The view is in the URL, so a reload preserves it.
    await page.reload()
    await expect(page.getByTestId('primary-currency-select')).toBeVisible()
    await expect(page).toHaveURL(/[?&]view=settings/)

    // The home icon returns to the converter and removes the param.
    await page.getByTestId('go-home').click()
    await expect(page.getByTestId('converter-base-select')).toBeVisible()
    await expect(page.getByTestId('primary-currency-select')).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]view=settings/)
  })

  test('the browser Back button returns from Settings to the converter', async ({ page }) => {
    await page.goto(APP)
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('primary-currency-select')).toBeVisible()

    await page.goBack()
    await expect(page.getByTestId('converter-base-select')).toBeVisible()
    await expect(page.getByTestId('primary-currency-select')).toHaveCount(0)
  })

  test('a direct load of ?view=settings renders Settings', async ({ page }) => {
    await page.goto(`${APP}?view=settings`)
    await expect(page.getByTestId('primary-currency-select')).toBeVisible()
    await expect(page.getByTestId('converter-base-select')).toHaveCount(0)
  })
})
