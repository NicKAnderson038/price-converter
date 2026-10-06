/**
 * Offline / freshness badge (T3).
 *
 * The displayed date is always the provider rate date (`snapshot.rateDate`),
 * never the local fetch time. `no-cache` explains that the first conversion
 * needs a connection.
 */

import type { RatesStatus } from '../hooks/useRates.ts'
import { formatRateDate } from '../lib/format.ts'

type Tone = 'ok' | 'warn' | 'error' | 'info'

export type StatusBadgeProps = {
  status: RatesStatus
  rateDate: string | null
  lastError: string | null
}

export function StatusBadge({ status, rateDate, lastError }: StatusBadgeProps) {
  let tone: Tone = 'info'
  let label = ''
  let detail: string | null = null

  const dateLabel = rateDate ? formatRateDate(rateDate) : null

  switch (status) {
    case 'fresh':
      tone = 'ok'
      label = 'Rates up to date'
      detail = dateLabel ? `Provider date ${dateLabel}` : null
      break
    case 'stale':
      tone = 'warn'
      label = 'Saved rates may be out of date'
      detail = dateLabel ? `Provider date ${dateLabel}` : null
      break
    case 'offline':
      tone = 'warn'
      label = 'Offline — using saved rates'
      detail = dateLabel ? `Provider date ${dateLabel}` : null
      break
    case 'no-cache':
      tone = 'error'
      label = 'No saved rates'
      detail = 'The first conversion needs a connection to download rates.'
      break
    case 'refreshing':
      tone = 'info'
      label = 'Checking for newer rates…'
      detail = dateLabel ? `Currently using provider date ${dateLabel}` : null
      break
  }

  return (
    <div
      className={`status status--${tone}`}
      data-testid="status-badge"
      data-status={status}
      role="status"
      aria-live="polite"
    >
      <span className="status__label">{label}</span>
      {detail ? <span className="status__detail">{detail}</span> : null}
      {status === 'offline' && lastError ? (
        <span className="status__detail status__error" title={lastError}>
          {lastError}
        </span>
      ) : null}
    </div>
  )
}

export default StatusBadge
