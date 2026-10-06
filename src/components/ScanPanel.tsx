/**
 * Scan panel (T6): the camera-OCR surface wired into the converter.
 *
 * Presentation for the `useScanner` hook. It shows the live preview with a
 * crop guide, surfaces the stable detection candidate for confirm-or-edit, and
 * always keeps a manual amount field. The converter amount only changes when
 * the user presses an explicit action ("Use detected" or the manual form); a
 * detected value never rewrites the amount on its own.
 *
 * The camera is opened only from the "Start camera" button. Closing the panel
 * unmounts it, which makes `useScanner` stop every track and terminate the OCR
 * worker.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ScannerStatus } from '../lib/scanner.ts'
import { parseAmount } from '../lib/parseAmount.ts'
import { useScanner } from '../hooks/useScanner.ts'

export interface ScanPanelProps {
  open: boolean
  /** Apply a confirmed value to the converter amount. */
  onConfirm: (value: number) => void
  onClose: () => void
}

const SCAN_INTERVAL_MS = 700

function statusLabel(status: ScannerStatus): string {
  switch (status) {
    case 'idle':
      return 'Camera is off.'
    case 'starting':
      return 'Starting camera…'
    case 'ready':
      return 'Point at the price and hold steady.'
    case 'scanning':
      return 'Reading…'
    case 'stopped':
      return 'Scanner stopped.'
    case 'error':
      return 'Scanner error.'
    default:
      return ''
  }
}

export function ScanPanel({ open, onConfirm, onClose }: ScanPanelProps) {
  const { status, candidate, failure, cameraBlocked, start, scanOnce } = useScanner({ open })

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const loopTimer = useRef<number | null>(null)
  const loopActive = useRef(false)
  const prefilledRef = useRef<number | null>(null)
  // Once the user types in the manual field, a later OCR candidate must not
  // overwrite their input.
  const manualDirtyRef = useRef(false)

  const [cameraStarted, setCameraStarted] = useState(false)
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)

  // Transient UI state resets each time the panel opens.
  useEffect(() => {
    if (!open) return
    setCameraStarted(false)
    setManual('')
    setManualError(null)
    prefilledRef.current = null
    manualDirtyRef.current = false
  }, [open])

  // Offer the detected value for editing without clobbering the user's typing:
  // prefill only while the field is pristine and the candidate value changes.
  useEffect(() => {
    if (!candidate) return
    if (manualDirtyRef.current) return
    if (prefilledRef.current === candidate.value) return
    prefilledRef.current = candidate.value
    setManual(String(candidate.value))
  }, [candidate])

  const stopLoop = useCallback(() => {
    loopActive.current = false
    if (loopTimer.current !== null) {
      window.clearTimeout(loopTimer.current)
      loopTimer.current = null
    }
  }, [])

  // One recognition at a time: the next tick is scheduled only after the
  // previous promise settles (recursive setTimeout, never setInterval).
  const step = useCallback(async (): Promise<void> => {
    if (!loopActive.current) return
    try {
      await scanOnce()
    } catch {
      // A busy race is expected and simply retried on the next tick.
    }
    if (!loopActive.current) return
    loopTimer.current = window.setTimeout(() => {
      void step()
    }, SCAN_INTERVAL_MS)
  }, [scanOnce])

  const startLoop = useCallback(() => {
    if (loopActive.current) return
    loopActive.current = true
    void step()
  }, [step])

  useEffect(() => stopLoop, [stopLoop])

  const handleStart = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    setManualError(null)
    const ready = await start(video)
    if (!ready) {
      setCameraStarted(false)
      return
    }
    setCameraStarted(true)
    // Best-effort, after the user gesture: ask for persistent storage so the
    // offline OCR/rate caches are less likely to be evicted. The result never
    // affects the scanner flow.
    try {
      const persist = navigator.storage?.persist
      if (typeof persist === 'function') {
        void persist.call(navigator.storage).catch(() => {})
      }
    } catch {
      // Persistence is a hint, never a requirement.
    }
    void video.play().catch(() => {
      // Autoplay of a muted stream can still be rejected; frames flow once
      // the user interacts with the page.
    })
    startLoop()
  }, [start, startLoop])

  // Explicit confirmation is the only path from a detection to the converter.
  const confirmValue = useCallback(
    (value: number) => {
      stopLoop()
      onConfirm(value)
    },
    [onConfirm, stopLoop],
  )

  const handleManual = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const parsed = parseAmount(manual)
      if (!parsed.ok) {
        setManualError('Enter a valid amount, e.g. 12.50')
        return
      }
      setManualError(null)
      confirmValue(parsed.value)
    },
    [confirmValue, manual],
  )

  const handleClose = useCallback(() => {
    stopLoop()
    onClose()
  }, [onClose, stopLoop])

  if (!open) return null

  return (
    <div
      className="scan-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Scan a price"
      data-testid="scanner-panel"
    >
      <div className="scan-panel__bar">
        <span className="scan-panel__title">Scan price</span>
        <button type="button" className="scan-panel__close" onClick={handleClose}>
          Close
        </button>
      </div>

      <div className="scan-panel__viewport">
        <video ref={videoRef} className="scan-panel__video" autoPlay playsInline muted />
        <div className="scan-panel__crop" aria-hidden="true" />
        {!cameraStarted && (
          <div className="scan-panel__placeholder">
            <button
              type="button"
              className="scan-panel__start"
              onClick={() => {
                void handleStart()
              }}
              disabled={status === 'starting' || cameraBlocked}
            >
              {status === 'starting' ? 'Starting camera…' : 'Start camera'}
            </button>
          </div>
        )}
      </div>

      {failure ? (
        <p className="scan-panel__error" role="alert">
          {failure.message}
        </p>
      ) : null}

      <p className="scan-panel__status" role="status">
        {statusLabel(status)}
      </p>

      <div className="scan-panel__candidate">
        <span className="scan-panel__candidate-label">Detected</span>
        <span className="scan-panel__candidate-value" data-testid="scanner-candidate">
          {candidate ? candidate.value : '—'}
        </span>
        {candidate && candidate.confirmations > 1 ? (
          <span className="scan-panel__candidate-count">×{candidate.confirmations}</span>
        ) : null}
        <button
          type="button"
          className="scan-panel__confirm"
          data-testid="scanner-confirm"
          disabled={!candidate}
          onClick={() => {
            if (candidate) confirmValue(candidate.value)
          }}
        >
          Use detected
        </button>
      </div>

      <form className="scan-panel__manual" onSubmit={handleManual}>
        <label className="scan-panel__manual-label" htmlFor="scanner-manual-amount">
          Enter or edit the amount manually
        </label>
        <input
          id="scanner-manual-amount"
          data-testid="scanner-manual-input"
          className="scan-panel__manual-input"
          inputMode="decimal"
          value={manual}
          onChange={(event) => {
            manualDirtyRef.current = true
            setManual(event.target.value)
          }}
          placeholder="12.50"
          autoComplete="off"
        />
        <button
          type="submit"
          className="scan-panel__manual-submit"
          data-testid="scanner-manual-submit"
        >
          Use amount
        </button>
      </form>
      {manualError ? (
        <p className="scan-panel__error" role="alert">
          {manualError}
        </p>
      ) : null}

      <style>{`
        .scan-panel {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 1rem;
          overflow-y: auto;
          background: #071B3C;
          color: #FFF9EC;
        }
        .scan-panel__bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .scan-panel__title {
          font-size: 1.125rem;
          font-weight: 600;
        }
        .scan-panel__close,
        .scan-panel__start,
        .scan-panel__confirm,
        .scan-panel__manual-submit {
          border: 0;
          border-radius: 0.5rem;
          padding: 0.6rem 0.9rem;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .scan-panel__close {
          background: transparent;
          color: #2BEEB4;
        }
        .scan-panel__viewport {
          position: relative;
          width: 100%;
          aspect-ratio: 3 / 4;
          max-height: 60vh;
          overflow: hidden;
          border-radius: 0.75rem;
          background: #04122A;
        }
        .scan-panel__video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .scan-panel__crop {
          position: absolute;
          top: 20%;
          left: 20%;
          width: 60%;
          height: 60%;
          border: 2px solid #2BEEB4;
          border-radius: 0.5rem;
          box-shadow: 0 0 0 9999px rgba(7, 27, 60, 0.55);
          pointer-events: none;
        }
        .scan-panel__placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .scan-panel__start,
        .scan-panel__confirm,
        .scan-panel__manual-submit {
          background: #2BEEB4;
          color: #071B3C;
        }
        .scan-panel__start:disabled,
        .scan-panel__confirm:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .scan-panel__status {
          margin: 0;
          color: #a9b8d6;
          font-size: 0.9rem;
        }
        .scan-panel__error {
          margin: 0;
          color: #ffb4b4;
        }
        .scan-panel__candidate {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem;
          border: 1px solid #1f3a68;
          border-radius: 0.75rem;
          background: #0b2450;
        }
        .scan-panel__candidate-label {
          color: #a9b8d6;
        }
        .scan-panel__candidate-value {
          font-size: 1.25rem;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: #2BEEB4;
        }
        .scan-panel__candidate-count {
          color: #7f93b8;
        }
        .scan-panel__candidate .scan-panel__confirm {
          margin-left: auto;
        }
        .scan-panel__manual {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-end;
          gap: 0.5rem;
        }
        .scan-panel__manual-label {
          width: 100%;
          color: #a9b8d6;
          font-size: 0.9rem;
        }
        .scan-panel__manual-input {
          flex: 1 1 8rem;
          padding: 0.6rem 0.75rem;
          border: 1px solid #1f3a68;
          border-radius: 0.5rem;
          background: #04122A;
          color: #FFF9EC;
          font: inherit;
        }
      `}</style>
    </div>
  )
}

export default ScanPanel
