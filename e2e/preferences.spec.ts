import { test, expect } from '@playwright/test'
import { PREFS_KEY } from './fixtures/rates'

const APP = '/price-converter/'

test.describe('settings + URL precedence', () => {
  test('a new primary currency in Settings persists across reloads', async ({ page }) => {
    await page.goto(APP)

    const primary = page.getByTestId('primary-currency-select')
    await expect(primary).toBeVisible()

    await primary.selectOption('JPY')

    // Persisted immediately through the storage module.
    const stored = await page.evaluate((key) => localStorage.getItem(key), PREFS_KEY)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string).primaryCurrency).toBe('JPY')

    await page.reload()
    await expect(page.getByTestId('primary-currency-select')).toHaveValue('JPY')

    // Still selected on a clean navigation with no URL hint.
    await page.goto(APP)
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

    // A parameterless reload still loads the saved primary.
    await page.goto(APP)
    await expect(page.getByTestId('primary-currency-select')).toHaveValue('GBP')
    await expect(page.getByTestId('converter-base-select')).toHaveValue('GBP')
  })
})
