/**
 * Converter screen (T3): amount input, base/target selectors, swap, result,
 * provider rate date, and offline/freshness status.
 *
 * Invalid URL codes are never substituted. When `base`/`target` is null the
 * select shows an explicit "not available" placeholder and the invalid raw
 * value is surfaced so the user must choose a currency.
 */

import { useMemo } from 'react'
import type { CurrencyInfo } from '../lib/currency.ts'
import type { RateSnapshot } from '../lib/rates.ts'
import type { RatesStatus } from '../hooks/useRates.ts'
import { formatNumber, formatRateDate } from '../lib/format.ts'
import { StatusBadge } from './StatusBadge.tsx'

export type ConverterProps = {
  base: string | null
  target: string | null
  invalidBase: string | null
  invalidTarget: string | null
  amountRaw: string
  amountError: string | null
  onAmountChange: (value: string) => void
  onBaseChange: (code: string) => void
  onTargetChange: (code: string) => void
  onSwap: () => void
  onRefresh: () => void
  onScan: () => void
  currencyOptions: readonly CurrencyInfo[]
  snapshot: RateSnapshot | null
  status: RatesStatus
  lastError: string | null
  resultValue: number | null
  resultFormatted: string | null
  resultError: string | null
  locale: string
}

function optionLabel(option: CurrencyInfo): string {
  const symbol = option.symbol ? ` ${option.symbol}` : ''
  return `${option.code}${symbol} — ${option.name}`
}

export function Converter({
  base,
  target,
  invalidBase,
  invalidTarget,
  amountRaw,
  amountError,
  onAmountChange,
  onBaseChange,
  onTargetChange,
  onSwap,
  onRefresh,
  onScan,
  currencyOptions,
  snapshot,
  status,
  lastError,
  resultValue,
  resultFormatted,
  resultError,
  locale,
}: ConverterProps) {
  const unitRate = useMemo(() => {
    if (snapshot === null || base === null || target === null) return null
    const from = snapshot.rates[base]
    const to = snapshot.rates[target]
    if (typeof from !== 'number' || typeof to !== 'number' || from === 0) return null
    return to / from
  }, [snapshot, base, target])

  const rateDate = snapshot?.rateDate ?? null

  return (
    <section className="converter" aria-label="Currency converter">
      <div className="field">
        <label className="field__label" htmlFor="amount-input">
          Amount{base ? ` in ${base}` : ''}
        </label>
        <div className="field__row">
          <input
            id="amount-input"
            data-testid="amount-input"
            className="input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={amountRaw}
            onChange={(event) => onAmountChange(event.target.value)}
            aria-invalid={amountError !== null}
            aria-describedby={amountError ? 'amount-error' : undefined}
          />
          <button
            type="button"
            className="button"
            data-testid="scan-price"
            onClick={onScan}
            aria-label="Scan a price with the camera"
          >
            Scan price
          </button>
        </div>
        {amountError ? (
          <p className="field__error" id="amount-error" role="alert">
            {amountError}
          </p>
        ) : null}
      </div>

      <div className="pair">
        <div className="field">
          <label className="field__label" htmlFor="base-currency">
            From
          </label>
          <select
            id="base-currency"
            data-testid="converter-base-select"
            className="select"
            value={base ?? ''}
            onChange={(event) => onBaseChange(event.target.value)}
          >
            {base === null ? (
              <option value="">
                {invalidBase ? `${invalidBase} — not available` : 'Choose a currency…'}
              </option>
            ) : null}
            {currencyOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="swap"
          onClick={onSwap}
          disabled={base === null || target === null}
          aria-label="Swap base and target currencies"
        >
          ⇅
        </button>

        <div className="field">
          <label className="field__label" htmlFor="target-currency">
            To
          </label>
          <select
            id="target-currency"
            data-testid="converter-target-select"
            className="select"
            value={target ?? ''}
            onChange={(event) => onTargetChange(event.target.value)}
          >
            {target === null ? (
              <option value="">
                {invalidTarget ? `${invalidTarget} — not available` : 'Choose a currency…'}
              </option>
            ) : null}
            {currencyOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {invalidBase ? (
        <p className="converter__invalid" role="alert" data-testid="invalid-base">
          The link's base currency “{invalidBase}” isn't available. Choose one to convert.
        </p>
      ) : null}
      {invalidTarget ? (
        <p className="converter__invalid" role="alert" data-testid="invalid-target">
          The link's target currency “{invalidTarget}” isn't available. Choose one to convert.
        </p>
      ) : null}

      <div className="converter__result">
        <span className="converter__result-label">Result</span>
        <output
          className="converter__result-value"
          data-testid="result"
          aria-live="polite"
          data-raw-value={resultValue === null ? undefined : String(resultValue)}
          title={resultValue === null ? undefined : String(resultValue)}
        >
          {resultFormatted ?? '—'}
        </output>
        {resultError ? (
          <p className="converter__error" role="alert">
            {resultError}
          </p>
        ) : null}
      </div>

      <div>
        {unitRate !== null && base && target ? (
          <p className="converter__meta">
            1 {base} = {formatNumber(unitRate, locale, { maximumFractionDigits: 4 })} {target}
          </p>
        ) : null}
        <p className="converter__meta">
          {rateDate
            ? `Provider rate date ${formatRateDate(rateDate, locale)}`
            : 'No provider rate date available yet'}
        </p>
      </div>

      <StatusBadge status={status} rateDate={rateDate} lastError={lastError} />

      <button
        type="button"
        className="button"
        data-testid="refresh-rates"
        onClick={onRefresh}
        disabled={status === 'refreshing'}
      >
        {status === 'refreshing' ? 'Refreshing…' : 'Refresh rates'}
      </button>
    </section>
  )
}

export default Converter
