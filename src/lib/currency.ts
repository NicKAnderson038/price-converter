/**
 * Currency catalogue for the Price Converter PWA.
 *
 * Provider: Frankfurter v2 (https://frankfurter.dev/). Its `GET /v2/currencies`
 * endpoint returns an array of objects shaped
 * `{ iso_code, iso_numeric, name, symbol, start_date, end_date }`.
 *
 * PROVENANCE / DATA DATE: 2026-10-06.
 * The intended build step (blueprint section 3) is to fetch
 *   https://api.frankfurter.dev/v2/currencies
 *   https://api.frankfurter.dev/v2/rates?base=USD
 * and hardcode the intersection of active iso_codes. In this environment the
 * sandbox proxy answered HTTP 403 ("Approval required for
 * api.frankfurter.dev:443"), so the live `/v2/currencies` + `/v2/rates` call
 * could not run. The list below is therefore PROVISIONAL: it is the
 * Frankfurter default-feed core, i.e. the European Central Bank daily reference
 * set plus the pegged currencies Frankfurter ships in `db/seeds/pegs`, with
 * names/symbols taken from the same `money` gem metadata Frankfurter uses
 * (RubyMoney/money `currency_iso.json` + `currency_non_iso.json`). Reconcile
 * against a live provider call and re-date this comment before release.
 *
 * `REGION_TO_CURRENCY` is a small maintained fallback suggestion map only. It
 * must never silently replace an explicit user choice.
 */

export type CurrencyInfo = {
  code: string
  name: string
  symbol: string
}

export const SUPPORTED_CURRENCIES: readonly CurrencyInfo[] = [
  { code: 'AED', name: 'United Arab Emirates Dirham', symbol: 'د.إ' },
  { code: 'ANG', name: 'Netherlands Antillean Guilder', symbol: 'ƒ' },
  { code: 'AUD', name: 'Australian Dollar', symbol: '$' },
  { code: 'BAM', name: 'Bosnia and Herzegovina Convertible Mark', symbol: 'КМ' },
  { code: 'BGN', name: 'Bulgarian Lev', symbol: 'лв.' },
  { code: 'BHD', name: 'Bahraini Dinar', symbol: 'د.ب' },
  { code: 'BMD', name: 'Bermudian Dollar', symbol: '$' },
  { code: 'BND', name: 'Brunei Dollar', symbol: '$' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { code: 'BTN', name: 'Bhutanese Ngultrum', symbol: 'Nu.' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: '$' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  { code: 'CMD', name: 'COMESA Dollar', symbol: '' },
  { code: 'CNY', name: 'Chinese Renminbi Yuan', symbol: '¥' },
  { code: 'CVE', name: 'Cape Verdean Escudo', symbol: '$' },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč' },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr.' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'FKP', name: 'Falkland Pound', symbol: '£' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'GGP', name: 'Guernsey Pound', symbol: '£' },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: '$' },
  { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
  { code: 'ILS', name: 'Israeli New Shekel', symbol: '₪' },
  { code: 'IMP', name: 'Isle of Man Pound', symbol: '£' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'ISK', name: 'Icelandic Króna', symbol: 'kr.' },
  { code: 'JEP', name: 'Jersey Pound', symbol: '£' },
  { code: 'JOD', name: 'Jordanian Dinar', symbol: 'د.ا' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩' },
  { code: 'MOP', name: 'Macanese Pataca', symbol: 'P' },
  { code: 'MXN', name: 'Mexican Peso', symbol: '$' },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
  { code: 'NIO', name: 'Nicaraguan Córdoba', symbol: 'C$' },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: '$' },
  { code: 'OMR', name: 'Omani Rial', symbol: 'ر.ع.' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
  { code: 'PLN', name: 'Polish Złoty', symbol: 'zł' },
  { code: 'QAR', name: 'Qatari Riyal', symbol: 'ر.ق' },
  { code: 'RON', name: 'Romanian Leu', symbol: 'Lei' },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'ر.س' },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: '$' },
  { code: 'SHP', name: 'Saint Helenian Pound', symbol: '£' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿' },
  { code: 'TMT', name: 'Turkmenistani Manat', symbol: 'm' },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺' },
  { code: 'USD', name: 'United States Dollar', symbol: '$' },
  { code: 'XAF', name: 'Central African Cfa Franc', symbol: 'CFA' },
  { code: 'XOF', name: 'West African Cfa Franc', symbol: 'Fr' },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
]

export const CURRENCY_CODES: ReadonlySet<string> = new Set(
  SUPPORTED_CURRENCIES.map((currency) => currency.code),
)

const BY_CODE: ReadonlyMap<string, CurrencyInfo> = new Map(
  SUPPORTED_CURRENCIES.map((currency) => [currency.code, currency]),
)

const CODE_SHAPE = /^[A-Za-z]{3}$/

/** Trim and upper-case a code; null when it is missing or not a 3-letter shape. */
export function normalizeCode(x: string | null | undefined): string | null {
  if (typeof x !== 'string') return null
  const trimmed = x.trim()
  if (!CODE_SHAPE.test(trimmed)) return null
  return trimmed.toUpperCase()
}

/** True when the code normalizes to a currency in the curated catalogue. */
export function isSupported(code: string): boolean {
  const normalized = normalizeCode(code)
  return normalized !== null && CURRENCY_CODES.has(normalized)
}

/**
 * Small, maintained region-subtag -> currency map used only as a first-run
 * suggestion fallback. Every value is a supported code.
 */
export const REGION_TO_CURRENCY: Readonly<Record<string, string>> = {
  AE: 'AED',
  AT: 'EUR',
  AU: 'AUD',
  BE: 'EUR',
  BG: 'BGN',
  BH: 'BHD',
  BM: 'BMD',
  BN: 'BND',
  BR: 'BRL',
  CA: 'CAD',
  CH: 'CHF',
  CN: 'CNY',
  CY: 'EUR',
  CZ: 'CZK',
  DE: 'EUR',
  DK: 'DKK',
  EE: 'EUR',
  ES: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  GB: 'GBP',
  GR: 'EUR',
  HK: 'HKD',
  HR: 'EUR',
  HU: 'HUF',
  ID: 'IDR',
  IE: 'EUR',
  IL: 'ILS',
  IN: 'INR',
  IS: 'ISK',
  IT: 'EUR',
  JO: 'JOD',
  JP: 'JPY',
  KR: 'KRW',
  LT: 'EUR',
  LU: 'EUR',
  LV: 'EUR',
  MT: 'EUR',
  MX: 'MXN',
  MY: 'MYR',
  NL: 'EUR',
  NO: 'NOK',
  NZ: 'NZD',
  OM: 'OMR',
  PH: 'PHP',
  PL: 'PLN',
  PT: 'EUR',
  QA: 'QAR',
  RO: 'RON',
  SA: 'SAR',
  SE: 'SEK',
  SG: 'SGD',
  SI: 'EUR',
  SK: 'EUR',
  TH: 'THB',
  TR: 'TRY',
  US: 'USD',
  ZA: 'ZAR',
}

/**
 * Suggest a supported currency from a BCP-47 locale, using the region subtag
 * (maximized when the locale omits one). Returns null when nothing matches.
 * This is a suggestion only; callers must confirm before applying it.
 */
export function suggestFromLocale(locale: string): string | null {
  if (typeof locale !== 'string' || locale.trim() === '') return null

  let region: string | undefined
  try {
    const parsed = new Intl.Locale(locale)
    region = parsed.region ?? parsed.maximize().region
  } catch {
    return null
  }
  if (!region) return null

  const code = REGION_TO_CURRENCY[region.toUpperCase()]
  if (!code) return null
  return isSupported(code) ? code : null
}

/** The display symbol for a supported code, or null when unknown/empty. */
export function currencySymbol(code: string): string | null {
  const normalized = normalizeCode(code)
  if (normalized === null) return null
  const info = BY_CODE.get(normalized)
  if (!info || info.symbol === '') return null
  return info.symbol
}
