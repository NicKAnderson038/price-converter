import { test, expect } from '@playwright/test'
import { MAX_AMOUNT, parseAmount } from '../src/lib/parseAmount.ts'

/**
 * Direct fixtures for the amount parser (blueprint section 4). These do not
 * need a browser page, but run inside the Playwright suite so the parser is
 * exercised from the same integrated code the app ships.
 */
test.describe('parseAmount fixtures', () => {
  const accepted: ReadonlyArray<readonly [string, number]> = [
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['¥1,200', 1200],
    ['12,50', 12.5],
  ]

  for (const [input, expected] of accepted) {
    test(`parses ${input} as ${expected}`, () => {
      const parsed = parseAmount(input)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value).toBeCloseTo(expected, 10)
      }
    })
  }

  test('rejects ambiguous 1,200 without a currency marker', () => {
    const parsed = parseAmount('1,200')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('ambiguous')
  })

  test('rejects negative amounts', () => {
    const parsed = parseAmount('-5')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('negative')
  })

  test('rejects amounts above MAX_AMOUNT', () => {
    const parsed = parseAmount(String(MAX_AMOUNT + 1))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('tooLarge')
  })
})
