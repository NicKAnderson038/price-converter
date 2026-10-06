/**
 * Versioned localStorage JSON for preferences and the rate snapshot.
 *
 * The UI must go through this module rather than touching `localStorage`.
 * Reads validate the stored shape and return null on missing/corrupt data;
 * writes swallow SecurityError/QuotaExceededError. A session in-memory
 * fallback keeps the app usable when persistent storage is unavailable.
 * No function throws to the caller.
 */

import { isSupported, normalizeCode } from './currency.ts'
import type { RateSnapshot } from './rates.ts'

export type Preferences = {
  schemaVersion: 1
  primaryCurrency: string
  targetCurrency: string
}

export type StorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unavailable' | 'quota' | 'corrupt' }

export const PREFERENCES_KEY = 'price-converter.preferences.v1'
export const RATES_KEY = 'price-converter.rates.v1'

const memory = new Map<string, string>()

function localStorageOrNull(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const probe = '__price_converter_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    return null
  }
}

/** Whether persistent (localStorage) storage is usable this session. */
export function storageAvailable(): boolean {
  return localStorageOrNull() !== null
}

function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22
    )
  }
  return false
}

function readRaw(key: string): string | null {
  const storage = localStorageOrNull()
  if (storage) {
    try {
      const value = storage.getItem(key)
      if (value !== null) return value
    } catch {
      // fall through to the in-memory fallback
    }
  }
  return memory.get(key) ?? null
}

function writeRaw(key: string, value: string): StorageResult<true> {
  memory.set(key, value)
  const storage = localStorageOrNull()
  if (!storage) return { ok: true, value: true }
  try {
    storage.setItem(key, value)
    return { ok: true, value: true }
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: 'quota' }
    return { ok: false, reason: 'unavailable' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function getPreferences(): Preferences | null {
  const raw = readRaw(PREFERENCES_KEY)
  if (raw === null) return null

  const parsed = parseJson(raw)
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null

  const primary = normalizeCode(
    typeof parsed.primaryCurrency === 'string' ? parsed.primaryCurrency : null,
  )
  const target = normalizeCode(
    typeof parsed.targetCurrency === 'string' ? parsed.targetCurrency : null,
  )
  if (primary === null || target === null) return null
  if (!isSupported(primary) || !isSupported(target)) return null

  return { schemaVersion: 1, primaryCurrency: primary, targetCurrency: target }
}

export function setPreferences(p: Preferences): StorageResult<true> {
  try {
    return writeRaw(PREFERENCES_KEY, JSON.stringify(p))
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

export function getRates(): RateSnapshot | null {
  const raw = readRaw(RATES_KEY)
  if (raw === null) return null

  const parsed = parseJson(raw)
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null
  if (parsed.provider !== 'frankfurter-v2' || parsed.base !== 'USD') return null
  if (typeof parsed.rateDate !== 'string' || parsed.rateDate === '') return null
  if (typeof parsed.fetchedAt !== 'string' || Number.isNaN(Date.parse(parsed.fetchedAt))) {
    return null
  }
  if (!isRecord(parsed.rates)) return null

  const rates: Record<string, number> = {}
  for (const [code, value] of Object.entries(parsed.rates)) {
    const normalized = normalizeCode(code)
    if (normalized === null) return null
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
    rates[normalized] = value
  }
  if (typeof rates.USD !== 'number' || rates.USD <= 0) return null

  return {
    schemaVersion: 1,
    provider: 'frankfurter-v2',
    base: 'USD',
    rates,
    rateDate: parsed.rateDate,
    fetchedAt: parsed.fetchedAt,
  }
}

export function setRates(s: RateSnapshot): StorageResult<true> {
  try {
    return writeRaw(RATES_KEY, JSON.stringify(s))
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
