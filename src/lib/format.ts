/**
 * Display formatting helpers (T3).
 *
 * All arithmetic stays in plain numbers; these functions only turn a number
 * into a localized string. If `Intl.NumberFormat` rejects a currency code the
 * runtime does not know (the curated catalogue is a superset of ISO 4217 — for
 * example `CMD`), the fallback keeps the UI alive instead of throwing during a
 * render. The unrounded calculation is never replaced by these strings.
 */

/** Plain localized number with a permissive precision default. */
export function formatNumber(
  value: number,
  locale?: string,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return '—'
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 6, ...options }).format(value)
  } catch {
    return String(value)
  }
}

/** Currency-styled value; falls back to `CODE 123.45` for unknown codes. */
export function formatCurrency(value: number, code: string, locale?: string): string {
  if (!Number.isFinite(value)) return '—'
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(value)
  } catch {
    return `${code} ${formatNumber(value, locale)}`
  }
}

/**
 * Render a provider `YYYY-MM-DD` date without timezone drift. The snapshot
 * stores a calendar date, so it is formatted in UTC.
 */
export function formatRateDate(rateDate: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rateDate)
  if (!match) return rateDate
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(date.getTime())) return rateDate
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
  } catch {
    return rateDate
  }
}
