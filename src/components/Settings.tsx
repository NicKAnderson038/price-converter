/**
 * Settings panel (T3).
 *
 * The primary and target selectors save through the storage module
 * immediately. A separate "Set as my primary currency" action deliberately
 * persists the current URL/selected base (so a URL override is never written
 * implicitly). About/Help lives in a lightweight `<details>` disclosure — no
 * router or dialog library.
 */

import type { CurrencyInfo } from '../lib/currency.ts'
import type { RateSnapshot } from '../lib/rates.ts'
import type { RatesStatus } from '../hooks/useRates.ts'

export type SettingsProps = {
  primary: string
  target: string
  /**
   * Whether `primary` was explicitly confirmed by the user (or settled on the
   * fallback default). A locale suggestion is only a pending proposal, so it
   * must not be presented as the user's primary currency.
   */
  primaryConfirmed: boolean
  currentBase: string | null
  onChangePrimary: (code: string) => void
  onChangeTarget: (code: string) => void
  onSetPrimary: () => void
  currencyOptions: readonly CurrencyInfo[]
  snapshot: RateSnapshot | null
  status: RatesStatus
}

function optionLabel(option: CurrencyInfo): string {
  return `${option.code}${option.name === option.code ? '' : ` — ${option.name}`}`
}

export function Settings({
  primary,
  target,
  primaryConfirmed,
  currentBase,
  onChangePrimary,
  onChangeTarget,
  onSetPrimary,
  currencyOptions,
  snapshot,
  status,
}: SettingsProps) {
  const offline = status === 'offline' || status === 'no-cache'

  const lacksRate = (code: string): boolean => {
    if (snapshot === null) return true
    return !Object.prototype.hasOwnProperty.call(snapshot.rates, code)
  }

  // "X is your primary currency" is only truthful once the primary is actually
  // confirmed; an unconfirmed locale suggestion must not borrow that state.
  const primaryIsConfirmed =
    primaryConfirmed && currentBase !== null && currentBase === primary
  const setPrimaryDisabled = currentBase === null || primaryIsConfirmed
  const setPrimaryLabel = primaryIsConfirmed
    ? `${primary} is your primary currency`
    : currentBase === null
      ? 'Set as my primary currency'
      : `Set ${currentBase} as my primary currency`

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 className="app__section-title" id="settings-heading">
        Settings
      </h2>

      <div className="field">
        <label className="field__label" htmlFor="primary-currency-select">
          Primary currency
        </label>
        <select
          id="primary-currency-select"
          data-testid="primary-currency-select"
          className="select"
          value={primary}
          onChange={(event) => onChangePrimary(event.target.value)}
        >
          {currencyOptions.map((option) => (
            <option key={option.code} value={option.code}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
        {offline && lacksRate(primary) ? (
          <p className="settings__hint" data-testid="primary-rate-hint">
            No cached rate for {primary} yet — its first rate download needs a connection.
          </p>
        ) : null}
      </div>

      <button
        type="button"
        className="button button--primary"
        data-testid="set-primary"
        onClick={onSetPrimary}
        disabled={setPrimaryDisabled}
      >
        {setPrimaryLabel}
      </button>

      <div className="field">
        <label className="field__label" htmlFor="settings-target-currency">
          Target currency
        </label>
        <select
          id="settings-target-currency"
          data-testid="settings-target-select"
          className="select"
          value={target}
          onChange={(event) => onChangeTarget(event.target.value)}
        >
          {currencyOptions.map((option) => (
            <option key={option.code} value={option.code}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
        {offline && lacksRate(target) ? (
          <p className="settings__hint" data-testid="target-rate-hint">
            No cached rate for {target} yet — its first rate download needs a connection.
          </p>
        ) : null}
      </div>

      <details className="settings__about">
        <summary>About &amp; help</summary>
        <div className="settings__about-content">
          <p>
            Price Converter converts amounts between currencies using daily
            reference rates from Frankfurter. Rates are informational, not a
            settlement quote.
          </p>
          <p>
            Your primary and target currencies are saved on this device. A link
            with <code>?base=…&amp;target=…</code> overrides them for that visit
            only; use “Set as my primary currency” to make a choice permanent.
          </p>
          <p>
            Rates are refreshed when you open the app, when you return to it, or
            with the refresh button. Without a connection the last saved rates
            are used, and the provider rate date is always shown.
          </p>
          <p>
            Camera scanning (coming in a later step) runs entirely on your
            device; images are never uploaded.
          </p>
        </div>
      </details>
    </section>
  )
}

export default Settings
