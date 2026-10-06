/**
 * Scanner lifecycle hook (T6).
 *
 * Owns exactly one `createScanner` instance for the lifetime of the scan
 * panel. The instance is created when `open` becomes true and is always torn
 * down — on close, when `open` turns false, and on unmount — by calling the
 * core's idempotent `stop()`, which stops every camera track and terminates
 * the OCR worker (late worker initialization is invalidated inside the core).
 *
 * The hook never opens the camera by itself: `start(video)` is only ever
 * called from a user gesture, exactly as blueprint section 4 requires. Core
 * error codes are mapped to human-readable copy; camera-blocking failures set
 * `cameraBlocked` so the caller keeps manual entry available.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createScanner } from '../lib/scanner.ts'
import type { ScanCandidate, ScannerHandle, ScannerStatus } from '../lib/scanner.ts'

export type ScannerFailure = {
  code: string
  message: string
}

/** User-facing copy for every error code the scanner core can emit. */
const ERROR_MESSAGES: Record<string, string> = {
  'insecure-context': 'Camera scanning needs HTTPS or localhost. Enter the amount manually.',
  'no-media-devices': 'This browser does not expose camera access. Enter the amount manually.',
  permission: 'Camera permission was denied. Enter the amount manually.',
  'no-camera': 'No camera was found. Enter the amount manually.',
  metadata: 'The camera stream did not become ready. Try again or enter the amount manually.',
  'worker-init': 'The OCR engine could not start. Enter the amount manually or try again.',
  recognize: 'Text recognition failed this frame. Hold the label steady, or enter it manually.',
}

/**
 * Codes that mean the camera itself cannot be used for this session, so manual
 * entry is the only route. `metadata`, `worker-init`, and `recognize` leave a
 * usable camera (or a retryable OCR path) and are not blocking.
 */
const CAMERA_BLOCKING: ReadonlySet<string> = new Set([
  'insecure-context',
  'no-media-devices',
  'permission',
  'no-camera',
])

/** Map a scanner error code to clear, manual-entry-preserving copy. */
export function describeScannerError(code: string): string {
  return ERROR_MESSAGES[code] ?? `Scanner error: ${code}. Enter the amount manually.`
}

export type UseScannerOptions = {
  /** Own the scanner only while true; stop on false and on unmount. */
  open: boolean
}

export type UseScannerResult = {
  status: ScannerStatus
  /** Last stable reading; retained until the panel is reset or unmounted. */
  candidate: ScanCandidate | null
  failure: ScannerFailure | null
  /** True after a camera-blocking error; manual entry stays the fallback. */
  cameraBlocked: boolean
  /** Acquire the camera and start OCR; resolves true once the scanner is ready. */
  start: (video: HTMLVideoElement) => Promise<boolean>
  /** One recognition pass; never queues (returns null while busy). */
  scanOnce: () => Promise<ScanCandidate | null>
  /** Stop tracks + worker immediately; safe to call repeatedly. */
  stop: () => void
}

export function useScanner({ open }: UseScannerOptions): UseScannerResult {
  const scannerRef = useRef<ScannerHandle | null>(null)
  const [status, setStatus] = useState<ScannerStatus>('idle')
  const [candidate, setCandidate] = useState<ScanCandidate | null>(null)
  const [failure, setFailure] = useState<ScannerFailure | null>(null)

  // Create on open, always stop on close/unmount. The cleanup runs on the
  // unmount and whenever `open` changes, so a closed panel can never leave the
  // camera or worker alive.
  useEffect(() => {
    if (!open) return
    const scanner = createScanner()
    scannerRef.current = scanner
    setStatus('idle')
    setCandidate(null)
    setFailure(null)

    const offError = scanner.onError((code) => {
      if (scannerRef.current !== scanner) return
      setFailure({ code, message: describeScannerError(code) })
      setStatus('error')
    })
    const offCandidate = scanner.onCandidate((next) => {
      if (scannerRef.current !== scanner) return
      setCandidate(next)
    })

    return () => {
      offError()
      offCandidate()
      if (scannerRef.current === scanner) scannerRef.current = null
      void scanner.stop()
    }
  }, [open])

  const start = useCallback(async (video: HTMLVideoElement): Promise<boolean> => {
    const scanner = scannerRef.current
    if (!scanner) return false
    setFailure(null)
    setStatus('starting')
    try {
      await scanner.start(video)
    } catch {
      // The core already emitted a specific error code via onError.
      if (scannerRef.current === scanner) setStatus('error')
      return false
    }
    if (scannerRef.current !== scanner) return false
    setStatus('ready')
    return true
  }, [])

  const scanOnce = useCallback(async (): Promise<ScanCandidate | null> => {
    const scanner = scannerRef.current
    if (!scanner) return null
    setStatus((prev) => (prev === 'ready' ? 'scanning' : prev))
    try {
      return await scanner.scanOnce()
    } catch {
      // A concurrent call losing the race is expected; the loop retries.
      return null
    } finally {
      if (scannerRef.current === scanner) {
        setStatus((prev) => (prev === 'scanning' ? 'ready' : prev))
      }
    }
  }, [])

  const stop = useCallback(() => {
    const scanner = scannerRef.current
    scannerRef.current = null
    setStatus('stopped')
    if (scanner) void scanner.stop()
  }, [])

  return {
    status,
    candidate,
    failure,
    cameraBlocked: failure !== null && CAMERA_BLOCKING.has(failure.code),
    start,
    scanOnce,
    stop,
  }
}

export default useScanner
