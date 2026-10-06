/**
 * Lazy camera + Tesseract.js OCR scanner core (T5).
 *
 * Design constraints (blueprint section 4):
 *  - `tesseract.js` is imported lazily through a dynamic `import()` inside
 *    `start()` / the first scan, never at module scope, so it stays out of the
 *    initial bundle.
 *  - One worker per scanner instance, created against the frozen `OCR_PATHS`
 *    vendored-asset contract.
 *  - Exactly one recognition is in flight at a time. `scanOnce()` rejects a
 *    concurrent call instead of queueing, and the caller schedules the next
 *    scan only after the previous promise settles. No `setInterval`; the frame
 *    is drawn as a bounded centered canvas crop and passed directly to
 *    `worker.recognize` (never a JPEG data URL).
 *  - Candidates are surfaced only after the same value is observed in
 *    `CONFIRMATIONS_REQUIRED` consecutive frames, so a user's saved amount is
 *    never silently rewritten by the scanner.
 *  - `stop()` is idempotent, stops every MediaStream track, terminates the
 *    worker, and bumps `initToken` to invalidate in-flight initialization so a
 *    worker that resolves late is discarded and terminated.
 *  - No image is ever uploaded; recognition runs locally in the worker.
 */

import { OCR_PATHS } from './ocrPaths.ts'
import { extractAmountCandidates, parseAmount } from './parseAmount.ts'

export type ScanCandidate = {
  value: number
  raw: string
  source: 'ocr'
  confirmations: number
}

export type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'scanning'
  | 'stopped'
  | 'error'

export interface ScannerHandle {
  readonly status: ScannerStatus
  start(video: HTMLVideoElement): Promise<void>
  scanOnce(): Promise<ScanCandidate | null>
  pause(): void
  stop(): Promise<void>
  onError(cb: (code: string, err?: unknown) => void): () => void
  onCandidate(cb: (c: ScanCandidate) => void): () => void
}

export type ScannerOptions = {
  /** Fraction of the frame (centered) drawn for recognition. Default 0.6. */
  cropRatio?: number
  /** Longest side of the drawn crop in pixels. Default 1000. */
  maxDimension?: number
}

/**
 * Shipping page-segmentation mode is `PSM.SINGLE_LINE` for a tight price crop.
 * TODO(measure): compare `PSM.SINGLE_BLOCK` on representative receipt photos
 * and switch if it reads multi-line labels more reliably.
 */
export const OCR_PSM_NOTE =
  'PSM.SINGLE_LINE is used for tight price crops; compare PSM.SINGLE_BLOCK on receipts later.'

const DEFAULT_CROP_RATIO = 0.6
const DEFAULT_MAX_DIMENSION = 1000
const CONFIRMATIONS_REQUIRED = 2
const METADATA_TIMEOUT_MS = 4000
// Mirrors the token shape used by parseAmount so a raw reading can be shown.
const RAW_TOKEN_PATTERN =
  /(?:[^\d\s]{1,4}[\s\u00A0\u2009\u202F]*)?\d(?:[\d.,\s\u00A0\u2009\u202F]*\d)?/g

type OcrWorker = {
  setParameters(params: Record<string, string>): Promise<unknown>
  recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }>
  terminate(): Promise<unknown>
}

type TesseractLike = {
  createWorker(
    langs: string,
    oem: number,
    options: { workerPath: string; corePath: string; langPath: string },
  ): Promise<OcrWorker>
  PSM: { SINGLE_LINE: string; SINGLE_BLOCK: string }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // An already-ended track can throw; cleanup is best-effort.
    }
  }
}

function classifyCameraError(err: unknown): string {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return 'permission'
      case 'NotFoundError':
      case 'DevicesNotFoundError':
      case 'OverconstrainedError':
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return 'no-camera'
      default:
        break
    }
  }
  return 'permission'
}

function resolveTesseract(mod: unknown): TesseractLike {
  const candidate = mod as { default?: TesseractLike } & Partial<TesseractLike>
  if (typeof candidate.createWorker === 'function') {
    return candidate as TesseractLike
  }
  if (candidate.default && typeof candidate.default.createWorker === 'function') {
    return candidate.default
  }
  throw new Error('tesseract.js did not expose createWorker')
}

async function safeTerminate(worker: OcrWorker): Promise<void> {
  try {
    await worker.terminate()
  } catch {
    // Termination is best-effort; a worker that never started may throw.
  }
}

export function createScanner(opts?: ScannerOptions): ScannerHandle {
  const cropRatio = clamp(opts?.cropRatio ?? DEFAULT_CROP_RATIO, 0.1, 1)
  const maxDimension = Math.max(
    64,
    Math.floor(opts?.maxDimension ?? DEFAULT_MAX_DIMENSION),
  )

  let status: ScannerStatus = 'idle'
  let stopped = false
  let paused = false
  let video: HTMLVideoElement | null = null
  let stream: MediaStream | null = null
  let worker: OcrWorker | null = null
  let initTask: Promise<OcrWorker | null> | null = null
  let initToken = 0
  let inFlight = false
  let canvas: HTMLCanvasElement | null = null
  let visibilityWired = false
  let pendingValue: number | null = null
  let confirmations = 0

  const errorListeners = new Set<(code: string, err?: unknown) => void>()
  const candidateListeners = new Set<(c: ScanCandidate) => void>()

  function emitError(code: string, err?: unknown): void {
    for (const cb of errorListeners) {
      try {
        cb(code, err)
      } catch {
        // A broken listener must not stop the scanner.
      }
    }
  }

  function emitCandidate(candidate: ScanCandidate): void {
    for (const cb of candidateListeners) {
      try {
        cb(candidate)
      } catch {
        // A broken listener must not stop the scanner.
      }
    }
  }

  function setStatus(next: ScannerStatus): void {
    if (!stopped) status = next
  }

  function onVisibility(): void {
    paused = typeof document !== 'undefined' && document.hidden
  }

  function wireVisibility(): void {
    if (visibilityWired || typeof document === 'undefined') return
    document.addEventListener('visibilitychange', onVisibility)
    visibilityWired = true
    paused = document.hidden
  }

  function unwireVisibility(): void {
    if (!visibilityWired || typeof document === 'undefined') return
    document.removeEventListener('visibilitychange', onVisibility)
    visibilityWired = false
  }

  function waitForMetadata(el: HTMLVideoElement): Promise<void> {
    if (el.readyState >= 1 && el.videoWidth > 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let timer = 0
      const cleanup = (): void => {
        el.removeEventListener('loadedmetadata', onLoaded)
        el.removeEventListener('error', onError)
        window.clearTimeout(timer)
      }
      const onLoaded = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(new Error('metadata'))
      }
      el.addEventListener('loadedmetadata', onLoaded, { once: true })
      el.addEventListener('error', onError, { once: true })
      timer = window.setTimeout(() => {
        cleanup()
        reject(new Error('metadata'))
      }, METADATA_TIMEOUT_MS)
    })
  }

  async function initWorker(token: number): Promise<OcrWorker | null> {
    let tesseract: TesseractLike
    try {
      const mod = await import('tesseract.js')
      tesseract = resolveTesseract(mod)
    } catch (err) {
      if (!stopped && token === initToken) {
        setStatus('error')
        emitError('worker-init', err)
      }
      return null
    }

    if (stopped || token !== initToken) return null

    let created: OcrWorker
    try {
      created = await tesseract.createWorker('eng', 1, {
        workerPath: OCR_PATHS.workerPath,
        corePath: OCR_PATHS.corePath,
        langPath: OCR_PATHS.langPath,
      })
    } catch (err) {
      if (!stopped && token === initToken) {
        setStatus('error')
        emitError('worker-init', err)
      }
      return null
    }

    // stop() may have run while createWorker was resolving: discard the worker.
    if (stopped || token !== initToken) {
      await safeTerminate(created)
      return null
    }

    try {
      await created.setParameters({
        tessedit_pageseg_mode: tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist: '0123456789.,',
      })
    } catch (err) {
      if (!stopped && token === initToken) emitError('worker-init', err)
    }

    // Re-check after the second await before publishing the worker.
    if (stopped || token !== initToken) {
      await safeTerminate(created)
      return null
    }

    worker = created
    return created
  }

  function ensureWorker(): Promise<OcrWorker | null> {
    if (worker) return Promise.resolve(worker)
    if (initTask) return initTask
    const token = initToken
    const task = initWorker(token)
    initTask = task
    const clear = (): void => {
      if (initTask === task) initTask = null
    }
    void task.then(clear, clear)
    return task
  }

  function drawCrop(el: HTMLVideoElement): HTMLCanvasElement | null {
    const width = el.videoWidth
    const height = el.videoHeight
    if (width <= 0 || height <= 0) return null

    const cropWidth = Math.max(1, Math.round(width * cropRatio))
    const cropHeight = Math.max(1, Math.round(height * cropRatio))
    const sourceX = Math.round((width - cropWidth) / 2)
    const sourceY = Math.round((height - cropHeight) / 2)

    const longest = Math.max(cropWidth, cropHeight)
    const scale = longest > maxDimension ? maxDimension / longest : 1
    const targetWidth = Math.max(1, Math.round(cropWidth * scale))
    const targetHeight = Math.max(1, Math.round(cropHeight * scale))

    if (!canvas) {
      if (typeof document === 'undefined') return null
      canvas = document.createElement('canvas')
    }
    if (canvas.width !== targetWidth) canvas.width = targetWidth
    if (canvas.height !== targetHeight) canvas.height = targetHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    try {
      ctx.drawImage(
        el,
        sourceX,
        sourceY,
        cropWidth,
        cropHeight,
        0,
        0,
        targetWidth,
        targetHeight,
      )
    } catch {
      return null
    }
    return canvas
  }

  function findRaw(text: string, value: number): string {
    for (const match of text.matchAll(RAW_TOKEN_PATTERN)) {
      const token = match[0].trim()
      const parsed = parseAmount(token)
      if (parsed.ok && parsed.value === value) return token
    }
    return text.trim()
  }

  function selectCandidate(text: string): ScanCandidate | null {
    const values: number[] = []
    for (const parsed of extractAmountCandidates(text)) {
      if (parsed.ok) values.push(parsed.value)
    }

    if (values.length === 0) {
      // Consecutive frames only: a frame with no reading resets stability.
      pendingValue = null
      confirmations = 0
      return null
    }

    let chosen = values[0]
    if (pendingValue !== null) {
      const stable = values.find((value) => value === pendingValue)
      if (stable !== undefined) chosen = stable
    }

    if (pendingValue !== null && chosen === pendingValue) {
      confirmations += 1
    } else {
      pendingValue = chosen
      confirmations = 1
    }

    if (confirmations < CONFIRMATIONS_REQUIRED) return null

    return {
      value: chosen,
      raw: findRaw(text, chosen),
      source: 'ocr',
      confirmations,
    }
  }

  async function start(videoEl: HTMLVideoElement): Promise<void> {
    if (stopped) throw new Error('scanner-stopped')

    const el = videoEl
    video = el
    setStatus('starting')

    // Adopt a stream the caller already attached, releasing any previous one
    // so a retry cannot leak the older MediaStream.
    const provided = el.srcObject
    if (provided instanceof MediaStream && provided.getVideoTracks().length > 0) {
      if (stream !== null && stream !== provided) stopTracks(stream)
      stream = provided
    }

    if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
      setStatus('error')
      emitError('insecure-context')
      throw new Error('insecure-context')
    }

    if (stream === null) {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        setStatus('error')
        emitError('no-media-devices')
        throw new Error('no-media-devices')
      }
      let acquired: MediaStream
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (err) {
        const code = classifyCameraError(err)
        setStatus('error')
        emitError(code, err)
        throw err instanceof Error ? err : new Error(code)
      }
      if (stopped) {
        stopTracks(acquired)
        throw new Error('scanner-stopped')
      }
      stream = acquired
      el.srcObject = acquired
    }

    try {
      await waitForMetadata(el)
    } catch (err) {
      if (!stopped) {
        setStatus('error')
        emitError('metadata', err)
      }
      throw err instanceof Error ? err : new Error('metadata')
    }

    if (stopped) return

    wireVisibility()

    const ready = await ensureWorker()
    if (stopped) return
    if (!ready) {
      setStatus('error')
      throw new Error('worker-init')
    }
    setStatus('ready')
  }

  async function scanOnce(): Promise<ScanCandidate | null> {
    if (stopped || paused) return null
    if (!video) return null

    // Refuse rather than queue. JS runs synchronously to the first await, so
    // the flag flips before any concurrent call can observe it as false.
    if (inFlight) throw new Error('scan-busy')
    inFlight = true
    setStatus('scanning')
    const token = initToken

    try {
      let activeWorker = worker
      if (!activeWorker) {
        activeWorker = await ensureWorker()
        if (!activeWorker) return null
      }

      const el = video
      if (!el || el.readyState < 2 || el.videoWidth === 0 || el.videoHeight === 0) {
        return null
      }

      const frame = drawCrop(el)
      if (!frame) return null

      let text = ''
      try {
        const result = await activeWorker.recognize(frame)
        text = result?.data?.text ?? ''
      } catch (err) {
        if (!stopped && token === initToken) {
          setStatus('error')
          emitError('recognize', err)
        }
        return null
      }

      // Discard results that arrive after stop() has invalidated this run.
      if (stopped || token !== initToken) return null

      const candidate = selectCandidate(text)
      if (candidate) emitCandidate(candidate)
      return candidate
    } finally {
      inFlight = false
      if (!stopped && token === initToken && status === 'scanning') {
        setStatus('ready')
      }
    }
  }

  function pause(): void {
    paused = true
  }

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    status = 'stopped'
    // Invalidate in-flight worker creation and recognition.
    initToken += 1
    paused = false
    inFlight = false
    pendingValue = null
    confirmations = 0

    unwireVisibility()

    const activeWorker = worker
    worker = null
    initTask = null

    const el = video
    const activeStream =
      stream ?? (el && el.srcObject instanceof MediaStream ? el.srcObject : null)
    if (activeStream) stopTracks(activeStream)
    if (el && el.srcObject) {
      try {
        el.srcObject = null
      } catch {
        // Detaching is best-effort.
      }
    }
    stream = null
    video = null
    canvas = null

    if (activeWorker) await safeTerminate(activeWorker)
  }

  return {
    get status(): ScannerStatus {
      return status
    },
    start,
    scanOnce,
    pause,
    stop,
    onError(cb) {
      errorListeners.add(cb)
      return () => {
        errorListeners.delete(cb)
      }
    },
    onCandidate(cb) {
      candidateListeners.add(cb)
      return () => {
        candidateListeners.delete(cb)
      }
    },
  }
}
