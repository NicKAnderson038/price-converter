/**
 * Amount parsing for typed input and OCR candidates.
 *
 * The rules deliberately do NOT "delete punctuation first" (blueprint section
 * 4). Both separators can appear in one value, and which one is decimal is
 * decided by position and context:
 *
 *   - both '.' and ',' present: the LAST one is the decimal separator.
 *   - one separator kind repeated >= 2 times: grouping.
 *   - one separator kind exactly once with 3 trailing digits: grouping ONLY
 *     when a currency symbol is present/hinted (e.g. `¥1,200`); otherwise
 *     ambiguous.
 *   - one separator kind exactly once with 1-2 trailing digits: decimal
 *     (`12,50` = 12.5).
 *   - one separator kind exactly once with >= 4 trailing digits: decimal.
 *
 * Rejects negative, non-finite, and values greater than MAX_AMOUNT.
 */

export const MAX_AMOUNT = 1e12

export type AmountParse =
  | { ok: true; value: number; format: 'dot-decimal' | 'comma-decimal' | 'grouping' }
  | {
      ok: false
      reason: 'empty' | 'invalid' | 'ambiguous' | 'nonfinite' | 'negative' | 'tooLarge'
    }

type DecimalFormat = 'dot-decimal' | 'comma-decimal' | 'grouping'

const CORE_SPACES = /[\s\u00A0\u2009\u202F]/

// Characters that plausibly identify a currency when attached to a number.
const CURRENCY_GLYPHS = /[$€£¥₩₪₹฿₺₽₫₴₦₱₲₵₡₸₼₾¢]/

/** Loose "this looks like a currency marker" test for stripped prefix/suffix. */
function looksLikeCurrency(marker: string): boolean {
  for (const ch of marker) {
    if (/[A-Za-z]/.test(ch)) return true
    if (CURRENCY_GLYPHS.test(ch)) return true
    const cp = ch.codePointAt(0)
    if (cp !== undefined && cp > 127) return true
  }
  return false
}

/**
 * Split a grouping-formatted integer part into plain digits, or return null
 * when the grouping structure is malformed (first group 1-3 digits, every
 * later group exactly 3).
 */
function groupingDigits(part: string, separator: string): string | null {
  if (part === '') return ''
  const groups = part.split(separator)
  for (const group of groups) {
    if (!/^\d+$/.test(group)) return null
  }
  if (groups.length === 1) return groups[0]
  if (groups[0].length > 3) return null
  for (let i = 1; i < groups.length; i += 1) {
    if (groups[i].length !== 3) return null
  }
  return groups.join('')
}

function decimalDigits(intPart: string, fracPart: string, separator = '.'): string | null {
  if (!/^\d+$/.test(fracPart)) return null
  if (intPart !== '' && !/^\d+$/.test(intPart)) return null
  return `${intPart === '' ? '0' : intPart}${separator}${fracPart}`
}

export function parseAmount(raw: string, opts?: { symbolHint?: string }): AmountParse {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }

  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }

  // Peel a leading marker ("$", "USD ", ...) and a trailing marker (" kr",
  // " EUR", ...) off the numeric core without deleting internal punctuation.
  const prefixMatch = trimmed.match(/^[^0-9+\-.,]+/)
  const prefix = prefixMatch ? prefixMatch[0] : ''
  const withoutPrefix = trimmed.slice(prefix.length)

  const suffixMatch = withoutPrefix.match(/[^0-9.,+\-]+$/)
  const suffix = suffixMatch ? suffixMatch[0] : ''
  const core = withoutPrefix.slice(0, withoutPrefix.length - suffix.length)

  if (core === '' || !/^[+\-]?[0-9][0-9.,\s\u00A0\u2009\u202F]*$/.test(core)) {
    return { ok: false, reason: 'invalid' }
  }

  const symbolPresent =
    Boolean(opts?.symbolHint && opts.symbolHint.trim() !== '') ||
    looksLikeCurrency(prefix) ||
    looksLikeCurrency(suffix)

  let negative = false
  let body = core.replace(CORE_SPACES, '')
  if (body.startsWith('-')) {
    negative = true
    body = body.slice(1)
  } else if (body.startsWith('+')) {
    body = body.slice(1)
  }
  if (body.includes('-') || body.includes('+')) return { ok: false, reason: 'invalid' }

  const dots = (body.match(/\./g) ?? []).length
  const commas = (body.match(/,/g) ?? []).length

  let valueStr: string
  let format: DecimalFormat

  if (dots === 0 && commas === 0) {
    if (!/^\d+$/.test(body)) return { ok: false, reason: 'invalid' }
    valueStr = body
    format = 'dot-decimal'
  } else if (dots > 0 && commas > 0) {
    // Both present: the last occurring separator is the decimal separator.
    const decimalSeparator = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ','
    const groupSeparator = decimalSeparator === '.' ? ',' : '.'
    const parts = body.split(decimalSeparator)
    if (parts.length !== 2) return { ok: false, reason: 'invalid' }
    const intPart = groupingDigits(parts[0], groupSeparator)
    if (intPart === null) return { ok: false, reason: 'invalid' }
    const assembled = decimalDigits(intPart, parts[1])
    if (assembled === null) return { ok: false, reason: 'invalid' }
    valueStr = assembled
    format = 'grouping'
  } else {
    const separator = dots > 0 ? '.' : ','
    const count = dots > 0 ? dots : commas

    if (count >= 2) {
      // Repeated single separator is grouping.
      const intPart = groupingDigits(body, separator)
      if (intPart === null) return { ok: false, reason: 'invalid' }
      valueStr = intPart
      format = 'grouping'
    } else {
      const trailing = body.length - body.indexOf(separator) - 1
      if (trailing === 0) return { ok: false, reason: 'invalid' }
      if (trailing === 3) {
        // Ambiguous thousands vs. 3-decimal unless a currency marks it.
        if (!symbolPresent) return { ok: false, reason: 'ambiguous' }
        const intPart = groupingDigits(body, separator)
        if (intPart === null) return { ok: false, reason: 'invalid' }
        valueStr = intPart
        format = 'grouping'
      } else {
        // 1-2 trailing digits (decimal) or >= 4 (unambiguously decimal).
        const parts = body.split(separator)
        if (parts.length !== 2) return { ok: false, reason: 'invalid' }
        const assembled = decimalDigits(parts[0], parts[1])
        if (assembled === null) return { ok: false, reason: 'invalid' }
        valueStr = assembled
        format = separator === '.' ? 'dot-decimal' : 'comma-decimal'
      }
    }
  }

  const value = Number(valueStr)
  if (!Number.isFinite(value)) return { ok: false, reason: 'nonfinite' }
  if (negative || value < 0) return { ok: false, reason: 'negative' }
  if (value > MAX_AMOUNT) return { ok: false, reason: 'tooLarge' }
  return { ok: true, value, format }
}

/**
 * Scan free text for numeric + currency-ish tokens and return every successful
 * parse, in first-seen order and de-duplicated by value+format. Ambiguous,
 * invalid, negative, and out-of-range readings are dropped so the scanner can
 * pick a stable candidate; the caller still lets the user edit.
 */
export function extractAmountCandidates(text: string): AmountParse[] {
  if (typeof text !== 'string' || text.trim() === '') return []

  const results: AmountParse[] = []
  const seen = new Set<string>()
  const tokenPattern =
    /(?:[^\d\s]{1,4}[\s\u00A0\u2009\u202F]*)?\d(?:[\d.,\s\u00A0\u2009\u202F]*\d)?/g

  for (const match of text.matchAll(tokenPattern)) {
    const parsed = parseAmount(match[0])
    if (!parsed.ok) continue
    const key = `${parsed.value}|${parsed.format}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(parsed)
  }
  return results
}
