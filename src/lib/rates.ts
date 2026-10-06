/**
 * Frankfurter v2 network adapter plus rate arithmetic.
 *
 * This module never persists anything; callers (storage.ts consumers) persist
 * the returned snapshot. The provider's wire rows are
 * `{ date, base, quote, rate }`; `/v2/rates?base=USD` is requested so the
 * snapshot base is USD and `USD: 1` is forced.
 */

import { normalizeCode } from './currency.ts'

export type RateSnapshot = {
  schemaVersion: 1
  provider: 'frankfurter-v2'
  base: 'USD'
  rates: Record<string, number>
  rateDate: string
  fetchedAt: string
}

export type FrankfurterRate = {
  date: string
  base: string
  quote: string
  rate: number
}

export type RatesErrorCode = 'network' | 'http' | 'parse' | 'validate'

export class RatesError extends Error {
  readonly code: RatesErrorCode

  constructor(message: string, code: RatesErrorCode) {
    super(message)
    this.name = 'RatesError'
    this.code = code
  }
}

const RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=USD'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/** Strict row validation: USD base, ISO date, 3-letter quote, positive finite rate. */
function validateRow(row: unknown): FrankfurterRate | null {
  if (typeof row !== 'object' || row === null) return null
  const record = row as Record<string, unknown>

  const base = normalizeCode(typeof record.base === 'string' ? record.base : null)
  const quote = normalizeCode(typeof record.quote === 'string' ? record.quote : null)
  if (base !== 'USD' || quote === null) return null
  if (!isIsoDate(record.date)) return null
  if (typeof record.rate !== 'number' || !Number.isFinite(record.rate) || record.rate <= 0) {
    return null
  }

  return { date: record.date, base, quote, rate: record.rate }
}

/**
 * Normalize provider rows into a snapshot: force `USD: 1`, keep the row with
 * the maximum date per quote, and set `rateDate` to the MIN of the kept dates
 * (conservative and disclosed). Invalid rows are skipped; throws when nothing
 * valid remains so callers never cache an empty/invalid snapshot.
 */
export function normalizeRates(rows: FrankfurterRate[], fetchedAt: string): RateSnapshot {
  const latestByQuote = new Map<string, FrankfurterRate>()

  for (const row of rows) {
    const valid = validateRow(row)
    if (!valid) continue
    const previous = latestByQuote.get(valid.quote)
    if (!previous || valid.date > previous.date) {
      latestByQuote.set(valid.quote, valid)
    }
  }

  if (latestByQuote.size === 0) {
    throw new RatesError('No valid rate rows to normalize', 'validate')
  }

  let rateDate: string | null = null
  for (const row of latestByQuote.values()) {
    if (rateDate === null || row.date < rateDate) rateDate = row.date
  }

  const rates: Record<string, number> = { USD: 1 }
  for (const [quote, row] of latestByQuote) {
    if (quote !== 'USD') rates[quote] = row.rate
  }

  if (rateDate === null) {
    throw new RatesError('No valid rate dates to normalize', 'validate')
  }

  return {
    schemaVersion: 1,
    provider: 'frankfurter-v2',
    base: 'USD',
    rates,
    rateDate,
    fetchedAt,
  }
}

/**
 * Fetch a fresh USD-base snapshot. Validates HTTP status, JSON array shape,
 * non-emptiness, every row's shape, ISO date, positive finite rate, and that
 * every row's base normalizes to USD. Throws RatesError on any violation so
 * callers never receive partial/invalid data.
 */
export async function fetchRates(opts?: { signal?: AbortSignal }): Promise<RateSnapshot> {
  let response: Response
  try {
    response = await fetch(RATES_URL, {
      signal: opts?.signal,
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    throw new RatesError('Network request to Frankfurter failed', 'network')
  }

  if (!response.ok) {
    throw new RatesError(`Frankfurter responded with HTTP ${response.status}`, 'http')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new RatesError('Frankfurter returned invalid JSON', 'parse')
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new RatesError('Frankfurter returned no rate rows', 'validate')
  }

  const rows: FrankfurterRate[] = []
  for (const entry of payload) {
    const valid = validateRow(entry)
    if (valid === null) {
      throw new RatesError('Frankfurter returned a rate row with an invalid shape', 'validate')
    }
    rows.push(valid)
  }

  return normalizeRates(rows, new Date().toISOString())
}

/** Exact blueprint cross-rate formula. Throws Error('Rate unavailable'). */
export function convert(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
): number {
  const source = rates[from]
  const target = rates[to]
  if (!Number.isFinite(amount) || !source || !target) {
    throw new Error('Rate unavailable')
  }
  return (amount / source) * target
}

/** True when `fetchedAt` is no more than `maxAgeMs` before `now`. */
export function isFresh(snapshot: RateSnapshot, now: number, maxAgeMs: number): boolean {
  const fetched = Date.parse(snapshot.fetchedAt)
  if (!Number.isFinite(fetched)) return false
  return now - fetched <= maxAgeMs
}
