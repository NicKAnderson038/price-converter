/**
 * Shared fixtures for the Playwright suite.
 *
 * The rates fixture mirrors the Frankfurter v2 wire rows
 * (`{ date, base, quote, rate }`) that `src/lib/rates.ts` normalizes. A USD
 * identity row is included on purpose (the normalizer forces `USD: 1`).
 */

export const PREFS_KEY = 'price-converter.preferences.v1'
export const RATES_KEY = 'price-converter.rates.v1'

export const RATES_FIXTURE_DATE = '2026-10-03'

export const RATES_FIXTURE = [
  { date: RATES_FIXTURE_DATE, base: 'USD', quote: 'USD', rate: 1 },
  { date: RATES_FIXTURE_DATE, base: 'USD', quote: 'EUR', rate: 0.8 },
  { date: RATES_FIXTURE_DATE, base: 'USD', quote: 'JPY', rate: 160 },
] as const

/** The provider date rendered with `en-US` by `formatRateDate`. */
export const RATES_FIXTURE_DATE_LABEL = 'Oct 3, 2026'

/**
 * A valid `RateSnapshot` (as validated by `storage.getRates`) for seeding
 * `localStorage` in the offline service-worker spec.
 */
export function savedSnapshot(fetchedAt: string) {
  return {
    schemaVersion: 1 as const,
    provider: 'frankfurter-v2' as const,
    base: 'USD' as const,
    rates: { USD: 1, EUR: 0.8, JPY: 160 },
    rateDate: RATES_FIXTURE_DATE,
    fetchedAt,
  }
}

export function savedPreferences(primaryCurrency: string, targetCurrency: string) {
  return { schemaVersion: 1 as const, primaryCurrency, targetCurrency }
}
