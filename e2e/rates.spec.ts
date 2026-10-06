import { test, expect } from '@playwright/test'
import { RATES_FIXTURE, RATES_FIXTURE_DATE_LABEL } from './fixtures/rates'

const APP = '/price-converter/'

test.describe('mocked provider rates + freshness', () => {
  test('computes from mocked rates and keeps the snapshot with an offline label after a failed refresh', async ({
    page,
  }) => {
    let failNext = false

    await page.route(/api\.frankfurter\.dev\/v2\/rates/, async (route) => {
      if (failNext) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'simulated provider failure' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RATES_FIXTURE),
      })
    })

    // 100 EUR -> USD at the fixture rate (USD:1 / EUR:0.8) == 125 USD.
    await page.goto(`${APP}?base=EUR&target=USD&amount=100`)

    const result = page.getByTestId('result')
    await expect(result).toHaveAttribute('data-raw-value', '125')
    await expect(result).toContainText('$125.00')

    // The displayed date is the provider rate date, not the local fetch time.
    await expect(page.getByText(`Provider rate date ${RATES_FIXTURE_DATE_LABEL}`)).toBeVisible()

    const badge = page.getByTestId('status-badge')
    await expect(badge).toHaveAttribute('data-status', 'fresh')

    // Now make the provider fail, then force a refresh.
    failNext = true
    await page.getByTestId('refresh-rates').click()

    await expect(badge).toHaveAttribute('data-status', 'offline')
    await expect(badge).toContainText('Offline')
    await expect(badge).toContainText('using saved rates')
    await expect(badge).toContainText('Provider date')
    await expect(badge).toContainText(RATES_FIXTURE_DATE_LABEL)

    // The saved snapshot is retained: the conversion and provider date remain.
    await expect(result).toHaveAttribute('data-raw-value', '125')
    await expect(page.getByText(`Provider rate date ${RATES_FIXTURE_DATE_LABEL}`)).toBeVisible()
  })

  test('repeat taps: the refresh control is disabled while a refresh is in flight', async ({
    page,
  }) => {
    let mode: 'fast' | 'slow' = 'fast'
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    await page.route(/api\.frankfurter\.dev\/v2\/rates/, async (route) => {
      if (mode === 'slow') await gate
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RATES_FIXTURE),
      })
    })

    await page.goto(`${APP}?base=EUR&target=USD&amount=100`)
    await expect(page.getByTestId('result')).toHaveAttribute('data-raw-value', '125')

    mode = 'slow'
    const refresh = page.getByTestId('refresh-rates')
    await refresh.click()
    await expect(refresh).toBeDisabled()
    await expect(page.getByTestId('status-badge')).toHaveAttribute('data-status', 'refreshing')

    release()
    await expect(page.getByTestId('status-badge')).toHaveAttribute('data-status', 'fresh')
    await expect(refresh).toBeEnabled()
  })
})

test.describe('provider date has no timezone drift', () => {
  // America/Los_Angeles enters DST on 2026-03-08; a naive local-time parse of
  // the calendar date would render 2026-03-07 there.
  test.use({ timezoneId: 'America/Los_Angeles' })

  test('a DST-boundary provider date renders as the same calendar date', async ({ page }) => {
    await page.route(/api\.frankfurter\.dev\/v2\/rates/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ date: '2026-03-08', base: 'USD', quote: 'EUR', rate: 0.8 }]),
      }),
    )

    await page.goto(`${APP}?base=EUR&target=USD&amount=100`)
    await expect(page.getByText('Provider rate date Mar 8, 2026')).toBeVisible()
    await expect(page.getByTestId('status-badge')).toContainText('Mar 8, 2026')
  })
})
