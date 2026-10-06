/**
 * Rates lifecycle (T3).
 *
 * Loads the persisted snapshot synchronously, then refreshes on app start, on
 * `visibilitychange` returning to visible, and on explicit user request. A
 * cached snapshot younger than one hour is treated as fresh and automatic
 * refreshes are skipped; user refresh always attempts a fetch. There is no
 * polling interval.
 *
 * `fetchedAt` is written only after a successful fetch (inside storage.setRates
 * on the freshly normalized snapshot). The DISPLAYED rate date always comes
 * from the provider `snapshot.rateDate`.
 *
 * Failure keeps the saved snapshot and reports `offline`; with nothing cached
 * it reports `no-cache`. An AbortController is aborted on unmount so no state
 * is written after teardown.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRates, isFresh, RatesError } from '../lib/rates.ts'
import type { RateSnapshot } from '../lib/rates.ts'
import { getRates, setRates } from '../lib/storage.ts'

/** Cached snapshots older than this may trigger an automatic fetch attempt. */
export const RATES_MAX_AGE_MS = 60 * 60 * 1000

export type RatesStatus = 'fresh' | 'stale' | 'offline' | 'no-cache' | 'refreshing'

export type UseRatesResult = {
  snapshot: RateSnapshot | null
  status: RatesStatus
  lastError: string | null
  refresh: (opts?: { force?: boolean }) => void
}

function initialStatus(snapshot: RateSnapshot | null): RatesStatus {
  if (snapshot === null) return 'no-cache'
  return isFresh(snapshot, Date.now(), RATES_MAX_AGE_MS) ? 'fresh' : 'stale'
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof RatesError) return error.message
  if (error instanceof Error) return error.message
  return 'Unable to refresh rates.'
}

export function useRates(): UseRatesResult {
  const [snapshot, setSnapshot] = useState<RateSnapshot | null>(() => getRates())
  const [status, setStatus] = useState<RatesStatus>(() => initialStatus(snapshot))
  const [lastError, setLastError] = useState<string | null>(null)

  const snapshotRef = useRef<RateSnapshot | null>(snapshot)
  const abortRef = useRef<AbortController | null>(null)
  const inflightRef = useRef(false)

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const refresh = useCallback((opts?: { force?: boolean }) => {
    const force = opts?.force ?? false
    if (inflightRef.current) return

    const cached = snapshotRef.current
    if (!force && cached !== null && isFresh(cached, Date.now(), RATES_MAX_AGE_MS)) {
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    inflightRef.current = true
    setStatus('refreshing')
    setLastError(null)

    fetchRates({ signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return
        setRates(next)
        snapshotRef.current = next
        setSnapshot(next)
        setStatus('fresh')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setLastError(errorMessage(error))
        setStatus(snapshotRef.current !== null ? 'offline' : 'no-cache')
      })
      .finally(() => {
        // Only the controller that is still current may clear the in-flight
        // flag; a teardown/re-invoke cycle may already have started a new one.
        if (abortRef.current === controller) {
          abortRef.current = null
          inflightRef.current = false
        }
      })
  }, [])

  // App start: only fetches when nothing is cached or the cache is >= 1h old.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Return to a visible tab re-checks freshness.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [refresh])

  // Abort any in-flight request on teardown; never write state after unmount.
  // Clearing the in-flight flag here lets a StrictMode/dev re-invoke (or a
  // fast remount) start a fresh request instead of short-circuiting.
  useEffect(() => {
    return () => {
      const controller = abortRef.current
      abortRef.current = null
      inflightRef.current = false
      controller?.abort()
    }
  }, [])

  return { snapshot, status, lastError, refresh }
}

export default useRates
