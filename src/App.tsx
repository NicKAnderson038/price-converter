/**
 * App shell (T3): resolves defaults, owns the converter selection, persists
 * preferences through the storage module, and composes Converter + Settings.
 *
 * Default precedence (blueprint section 2):
 *   (a) valid URL values for this visit
 *   (b) saved storage.getPreferences() primary/target
 *   (c) suggestFromLocale(navigator.language), pending user confirmation
 *   (d) USD
 *
 * An explicit URL `base` overrides the saved primary for the visit only; it is
 * never written back to storage. An invalid URL code is surfaced and never
 * substituted.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Converter } from './components/Converter.tsx'
import { Settings } from './components/Settings.tsx'
import { useRates } from './hooks/useRates.ts'
import { SUPPORTED_CURRENCIES, suggestFromLocale } from './lib/currency.ts'
import type { CurrencyInfo } from './lib/currency.ts'
import { formatCurrency } from './lib/format.ts'
import { parseAmount } from './lib/parseAmount.ts'
import type { AmountParse } from './lib/parseAmount.ts'
import { convert } from './lib/rates.ts'
import { getPreferences, setPreferences } from './lib/storage.ts'
import { parseUrlState, updateUrlSearch } from './lib/urlState.ts'
import type { UrlPatch } from './lib/urlState.ts'

type AppState = {
  /**
   * Which view the shell shows. This is a plain query-param view (`?view=settings`)
   * with no router dependency, so the GitHub Pages build needs no rewrites.
   */
  view: 'home' | 'settings'
  /** Current visit base; null means the URL code was invalid and needs a pick. */
  base: string | null
  target: string | null
  invalidBase: string | null
  invalidTarget: string | null
  amountRaw: string
  /** Persisted primary shown in Settings (independent of a URL override). */
  settingsPrimary: string
  settingsTarget: string
  suggested: string | null
  showSuggestion: boolean
  /**
   * Whether `settingsPrimary` was explicitly chosen by the user. A locale
   * suggestion shown in Settings is only a pending proposal until the banner,
   * the primary selector, or "Set as my primary currency" confirms it; until
   * then it must never be written to storage.
   */
  primaryConfirmed: boolean
}

// The scanner (and its tesseract/camera code) is loaded only when the user
// opens it; nothing here is in the initial converter path.
const ScanPanel = lazy(() => import('./components/ScanPanel.tsx'))

/**
 * Render a confirmed scanned value as converter input text without introducing
 * exponent notation that `parseAmount` would reject.
 */
function formatScannedAmount(value: number): string {
  if (!Number.isFinite(value)) return ''
  const text = String(value)
  if (!/[eE]/.test(text)) return text
  return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
}

function readSearch(): string {
  if (typeof window === 'undefined') return ''
  return window.location.search
}

/**
 * Pure-ish initial resolution. Reads storage and the locale once per call; no
 * invalid code is ever replaced by a fallback.
 */
function resolveInitialSelection(
  search: string,
  rates: Record<string, number> | null,
): AppState {
  const parsed = parseUrlState(search, rates)
  const saved = getPreferences()
  const locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language
  const suggested = suggestFromLocale(locale)

  let base: string | null
  let invalidBase: string | null = null
  if (parsed.base.state === 'valid') {
    base = parsed.base.code
  } else if (parsed.base.state === 'invalid') {
    base = null
    invalidBase = parsed.base.raw
  } else {
    base = saved?.primaryCurrency ?? suggested ?? 'USD'
  }

  let target: string | null
  let invalidTarget: string | null = null
  if (parsed.target.state === 'valid') {
    target = parsed.target.code
  } else if (parsed.target.state === 'invalid') {
    target = null
    invalidTarget = parsed.target.raw
  } else if (saved?.targetCurrency) {
    target = saved.targetCurrency
  } else if (suggested && suggested !== base) {
    target = suggested
  } else {
    target = base === 'USD' ? 'EUR' : 'USD'
  }

  // Amount: valid -> keep raw text; invalid -> keep raw and surface an error;
  // absent -> the conventional 1.
  let amountRaw = '1'
  if (parsed.amount.state === 'valid' || parsed.amount.state === 'invalid') {
    amountRaw = parsed.amount.raw
  }

  const settingsPrimary = saved?.primaryCurrency ?? suggested ?? 'USD'
  const settingsTarget =
    saved?.targetCurrency ??
    (suggested && suggested !== settingsPrimary
      ? suggested
      : settingsPrimary === 'USD'
        ? 'EUR'
        : 'USD')

  return {
    view: parsed.view,
    base,
    target,
    invalidBase,
    invalidTarget,
    amountRaw,
    settingsPrimary,
    settingsTarget,
    suggested,
    showSuggestion: saved === null && suggested !== null,
    primaryConfirmed: saved !== null,
  }
}

function describeAmountError(parsed: AmountParse): string | null {
  if (parsed.ok) return null
  switch (parsed.reason) {
    case 'empty':
      return 'Enter an amount.'
    case 'ambiguous':
      return 'That amount is ambiguous — use a clearer decimal separator.'
    case 'negative':
      return 'Amount must not be negative.'
    case 'tooLarge':
      return 'Amount is too large.'
    case 'nonfinite':
    case 'invalid':
    default:
      return 'Enter a valid number.'
  }
}

function App() {
  const rates = useRates()
  const [state, setState] = useState<AppState>(() =>
    resolveInitialSelection(readSearch(), rates.snapshot?.rates ?? null),
  )
  const [scanOpen, setScanOpen] = useState(false)
  // Focus targets for change-view accessibility: the Settings heading and the
  // converter region (the header h1 stays put above both views).
  const settingsHeadingRef = useRef<HTMLHeadingElement>(null)
  const converterRef = useRef<HTMLDivElement>(null)

  const locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language

  const snapshot = rates.snapshot
  const ratesByCode = snapshot?.rates ?? null

  const currencyOptions = useMemo<CurrencyInfo[]>(() => {
    const byCode = new Map<string, CurrencyInfo>()
    for (const currency of SUPPORTED_CURRENCIES) byCode.set(currency.code, currency)
    if (snapshot !== null) {
      for (const code of Object.keys(snapshot.rates)) {
        if (!byCode.has(code)) byCode.set(code, { code, name: code, symbol: '' })
      }
    }
    for (const code of [
      state.base,
      state.target,
      state.settingsPrimary,
      state.settingsTarget,
    ]) {
      if (code && !byCode.has(code)) byCode.set(code, { code, name: code, symbol: '' })
    }
    return [...byCode.values()]
  }, [snapshot, state.base, state.target, state.settingsPrimary, state.settingsTarget])

  const parsedAmount = useMemo(() => parseAmount(state.amountRaw), [state.amountRaw])
  const amountError = describeAmountError(parsedAmount)

  const conversion = useMemo(() => {
    if (!parsedAmount.ok || state.base === null || state.target === null || snapshot === null) {
      return null
    }
    try {
      const value = convert(parsedAmount.value, state.base, state.target, snapshot.rates)
      if (!Number.isFinite(value)) return null
      return { value, formatted: formatCurrency(value, state.target, locale) }
    } catch {
      return null
    }
  }, [parsedAmount, state.base, state.target, snapshot, locale])

  const resultError = useMemo(() => {
    if (amountError) return amountError
    if (state.base === null || state.target === null) {
      return 'Choose both currencies to convert.'
    }
    if (snapshot === null) {
      return 'No saved rates yet — the first conversion needs a connection.'
    }
    const from = snapshot.rates[state.base]
    const to = snapshot.rates[state.target]
    if (typeof from !== 'number' || typeof to !== 'number') {
      return `No ${state.base} → ${state.target} rate is saved. Refresh while online.`
    }
    if (conversion === null) return 'Rate unavailable.'
    return null
  }, [amountError, state.base, state.target, snapshot, conversion])

  function applyUrl(patch: UrlPatch) {
    if (typeof window === 'undefined') return
    try {
      const nextSearch = updateUrlSearch(window.location.search, patch)
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    } catch {
      // URL sync is a convenience; never break the conversion over it.
    }
  }

  /**
   * Switch views and mirror the choice in the URL. Unlike converter param
   * changes (`applyUrl`, replaceState), view changes push a history entry so the
   * browser Back button returns to the previous view. Going home removes the
   * `view` param rather than writing `view=home`.
   */
  function navigateToView(view: 'home' | 'settings') {
    setState((prev) => ({ ...prev, view }))
    if (typeof window === 'undefined') return
    try {
      const nextSearch = updateUrlSearch(window.location.search, {
        view: view === 'settings' ? 'settings' : null,
      })
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.pushState(null, '', nextUrl)
    } catch {
      // View navigation is a convenience; never break rendering over it.
    }
  }

  const persistPreferences = (primary: string, targetCode: string) => {
    setPreferences({ schemaVersion: 1, primaryCurrency: primary, targetCurrency: targetCode })
  }

  const handleAmountChange = (value: string) => {
    setState((prev) => ({ ...prev, amountRaw: value }))
    applyUrl({ amount: value === '' ? null : value })
  }

  /**
   * The scanner's explicit confirmation. It only touches the amount (through
   * the existing amount handler); the currency pair is never rewritten here.
   * The detected base hint, if any, is applied by `handleBaseChange` from its
   * own visible button inside the panel.
   */
  const handleScanConfirm = (value: number) => {
    setScanOpen(false)
    handleAmountChange(formatScannedAmount(value))
  }

  const handleBaseChange = (code: string) => {
    setState((prev) => ({ ...prev, base: code, invalidBase: null }))
    applyUrl({ base: code })
  }

  const handleTargetChange = (code: string) => {
    setState((prev) => ({ ...prev, target: code, invalidTarget: null }))
    applyUrl({ target: code })
  }

  const handleSwap = () => {
    if (state.base === null || state.target === null) return
    const nextBase = state.target
    const nextTarget = state.base
    setState((prev) => ({
      ...prev,
      base: nextBase,
      target: nextTarget,
      invalidBase: null,
      invalidTarget: null,
    }))
    applyUrl({ base: nextBase, target: nextTarget })
  }

  const handlePrimaryChange = (code: string) => {
    const nextTarget = state.settingsTarget
    setState((prev) => ({
      ...prev,
      settingsPrimary: code,
      primaryConfirmed: true,
      base: code,
      invalidBase: null,
      showSuggestion: false,
    }))
    persistPreferences(code, nextTarget)
    applyUrl({ base: code })
  }

  const handleSettingsTargetChange = (code: string) => {
    setState((prev) => ({
      ...prev,
      settingsTarget: code,
      target: code,
      invalidTarget: null,
    }))
    // Persist the target only when a primary has already been confirmed. An
    // unconfirmed locale suggestion must never become the saved primary, so
    // leaving the target in memory until confirmation keeps the suggestion
    // banner available on a later visit.
    if (state.primaryConfirmed) {
      persistPreferences(state.settingsPrimary, code)
    }
    applyUrl({ target: code })
  }

  const handleSetPrimary = () => {
    if (state.base === null) return
    const primary = state.base
    setState((prev) => ({
      ...prev,
      settingsPrimary: primary,
      primaryConfirmed: true,
      showSuggestion: false,
    }))
    persistPreferences(primary, state.settingsTarget)
  }

  const handleConfirmSuggestion = () => {
    setState((prev) => ({
      ...prev,
      primaryConfirmed: true,
      showSuggestion: false,
    }))
    persistPreferences(state.settingsPrimary, state.settingsTarget)
  }

  const handleDismissSuggestion = () => {
    // Dismissing the suggestion settles the fallback primary (the precedence-(d)
    // default, USD) as confirmed. Without this, `primaryConfirmed` stayed false,
    // so a later target-only change ran in memory but was never persisted and
    // silently reverted on reload. Keep the banner dismissed and preserve the
    // current target (a target the user already picked must not be discarded).
    // When the suggested primary left `settingsTarget` equal to the fallback
    // (fresh fr-FR: EUR suggested, USD fallback target), settle to the
    // non-degenerate counterpart so the converter cannot land on USD→USD.
    const fallbackPrimary = 'USD'
    const nextTarget =
      state.settingsTarget === fallbackPrimary
        ? fallbackPrimary === 'USD'
          ? 'EUR'
          : 'USD'
        : state.settingsTarget
    setState((prev) => ({
      ...prev,
      settingsPrimary: fallbackPrimary,
      settingsTarget: nextTarget,
      primaryConfirmed: true,
      showSuggestion: false,
    }))
    persistPreferences(fallbackPrimary, nextTarget)
  }

  // Back/forward re-reads the URL for the view and the converter selection;
  // saved preferences are unaffected.
  useEffect(() => {
    const onPopState = () => {
      const next = resolveInitialSelection(readSearch(), ratesByCode)
      setState((prev) => ({
        ...prev,
        view: next.view,
        base: next.base,
        target: next.target,
        invalidBase: next.invalidBase,
        invalidTarget: next.invalidTarget,
        amountRaw: next.amountRaw,
      }))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [ratesByCode])

  // Change-view accessibility: keep the document title in sync and move focus
  // to the newly shown view's heading/region. The first render is skipped so a
  // direct page load never steals focus from the browser chrome.
  const firstViewRender = useRef(true)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title =
        state.view === 'settings' ? 'Settings · Price Converter' : 'Price Converter'
    }
    if (firstViewRender.current) {
      firstViewRender.current = false
      return
    }
    const target =
      state.view === 'settings' ? settingsHeadingRef.current : converterRef.current
    target?.focus()
  }, [state.view])

  return (
    <main className="app">
      <header className="app__header">
        <div className="app__heading">
          <h1 className="app__title">Price Converter</h1>
          <p className="app__tagline">
            Works online or offline
          </p>
        </div>
        {state.view === 'settings' ? (
          <button
            type="button"
            className="icon-button"
            data-testid="go-home"
            aria-label="Back to converter"
            onClick={() => navigateToView('home')}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="icon-button"
            data-testid="open-settings"
            aria-label="Open settings"
            onClick={() => navigateToView('settings')}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
      </header>

      {state.view === 'settings' ? (
        <Settings
          headingRef={settingsHeadingRef}
          primary={state.settingsPrimary}
          target={state.settingsTarget}
          primaryConfirmed={state.primaryConfirmed}
          currentBase={state.base}
          onChangePrimary={handlePrimaryChange}
          onChangeTarget={handleSettingsTargetChange}
          onSetPrimary={handleSetPrimary}
          currencyOptions={currencyOptions}
          snapshot={snapshot}
          status={rates.status}
        />
      ) : (
        <>
          {state.showSuggestion && state.suggested ? (
            <div className="suggestion" role="status">
              <p>
                It looks like you use <strong>{state.suggested}</strong>. Use it as your
                primary currency?
              </p>
              <div className="suggestion__actions">
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="confirm-suggestion"
                  onClick={handleConfirmSuggestion}
                >
                  Yes, use {state.suggested}
                </button>
                <button
                  type="button"
                  className="button"
                  data-testid="dismiss-suggestion"
                  onClick={handleDismissSuggestion}
                >
                  Not now
                </button>
              </div>
            </div>
          ) : null}

          <div className="app__converter" ref={converterRef} tabIndex={-1}>
            <Converter
              base={state.base}
              target={state.target}
              invalidBase={state.invalidBase}
              invalidTarget={state.invalidTarget}
              amountRaw={state.amountRaw}
              amountError={amountError}
              onAmountChange={handleAmountChange}
              onBaseChange={handleBaseChange}
              onTargetChange={handleTargetChange}
              onSwap={handleSwap}
              onRefresh={() => rates.refresh({ force: true })}
              onScan={() => setScanOpen(true)}
              currencyOptions={currencyOptions}
              snapshot={snapshot}
              status={rates.status}
              lastError={rates.lastError}
              resultValue={conversion?.value ?? null}
              resultFormatted={conversion?.formatted ?? null}
              resultError={resultError}
              locale={locale}
            />
          </div>

          {scanOpen ? (
            <Suspense
              fallback={
                <div className="scan-loading" role="status" data-testid="scanner-loading">
                  Loading scanner…
                </div>
              }
            >
              <ScanPanel
                open={scanOpen}
                onConfirm={handleScanConfirm}
                onClose={() => setScanOpen(false)}
              />
            </Suspense>
          ) : null}
        </>
      )}
    </main>
  )
}

export default App
