/**
 * URL state for the single converter screen (`?base&target&amount`).
 *
 * Rules (blueprint section 2):
 *   - `amount` must parse to a finite, nonnegative number <= MAX_AMOUNT.
 *   - A currency code is valid when it is in the curated catalogue OR appears
 *     in the current RateSnapshot.rates (provider coverage is authoritative
 *     whenever a snapshot is present).
 *   - An invalid code is NEVER silently replaced. It is returned as `invalid`
 *     so the UI can surface it and ask the user to pick a currency.
 *   - There is no `isFlipped` concept; swapping only exchanges the two codes.
 *
 * The update helpers operate on a raw query string and preserve every
 * parameter they were not asked to change, so future/unknown params survive.
 */

import { isSupported, normalizeCode } from './currency.ts'
import { MAX_AMOUNT, parseAmount } from './parseAmount.ts'

export type ParsedCurrency =
  | { state: 'valid'; code: string }
  | { state: 'invalid'; raw: string }
  | { state: 'absent' }

export type ParsedAmount =
  | { state: 'valid'; value: number; raw: string }
  | { state: 'invalid'; raw: string }
  | { state: 'absent' }

/**
 * The visible view. There is deliberately no router: the view is a plain query
 * parameter (`?view=settings`) so the static GitHub Pages build needs no
 * server-side rewrites, and an absent or unknown value falls back to `home`.
 */
export type ViewName = 'home' | 'settings'

export type ParsedUrlState = {
  base: ParsedCurrency
  target: ParsedCurrency
  amount: ParsedAmount
  view: ViewName
}

export type UrlPatch = {
  base?: string | null
  target?: string | null
  amount?: string | number | null
  view?: ViewName | null
}

function ratesHas(
  rates: Record<string, number> | null | undefined,
  code: string,
): boolean {
  return (
    rates !== null &&
    rates !== undefined &&
    Object.prototype.hasOwnProperty.call(rates, code)
  )
}

function parseCurrencyParam(
  raw: string | null,
  rates: Record<string, number> | null | undefined,
): ParsedCurrency {
  if (raw === null || raw.trim() === '') return { state: 'absent' }
  const code = normalizeCode(raw)
  if (code === null) return { state: 'invalid', raw }
  if (isSupported(code) || ratesHas(rates, code)) return { state: 'valid', code }
  return { state: 'invalid', raw }
}

function parseAmountParam(raw: string | null): ParsedAmount {
  if (raw === null || raw.trim() === '') return { state: 'absent' }
  const parsed = parseAmount(raw)
  if (!parsed.ok) return { state: 'invalid', raw }
  // parseAmount already enforces this; kept explicit so the URL bound is
  // obvious and stays correct if the parser changes.
  if (parsed.value < 0 || parsed.value > MAX_AMOUNT) {
    return { state: 'invalid', raw }
  }
  return { state: 'valid', value: parsed.value, raw }
}

/**
 * Parse the current query string. `rates` is the active snapshot's rate map
 * (or null when nothing is cached); it widens the set of accepted codes to the
 * provider's current coverage without ever substituting a value.
 */
export function parseUrlState(
  search: string,
  rates?: Record<string, number> | null,
): ParsedUrlState {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    params = new URLSearchParams()
  }
  return {
    base: parseCurrencyParam(params.get('base'), rates),
    target: parseCurrencyParam(params.get('target'), rates),
    amount: parseAmountParam(params.get('amount')),
    view: params.get('view') === 'settings' ? 'settings' : 'home',
  }
}

/**
 * Return a new query string (no leading `?`) with `patch` applied. A null or
 * empty value removes the parameter; everything else is preserved verbatim.
 */
export function updateUrlSearch(search: string, patch: UrlPatch): string {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    params = new URLSearchParams()
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') {
      params.delete(key)
    } else {
      params.set(key, String(value))
    }
  }

  return params.toString()
}

/** Exchange the two currency codes in the query string. */
export function swapUrlCurrencies(search: string, base: string, target: string): string {
  return updateUrlSearch(search, { base: target, target: base })
}
