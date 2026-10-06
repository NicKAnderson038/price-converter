/**
 * Lazy onnxruntime-web wrapper for the PP-OCRv3 recognition model (Stage 3).
 *
 * Browser-only and dependency-free at module scope:
 *  - `onnxruntime-web/wasm` is loaded through a *dynamic* `import()` inside the
 *    warm-up path, never a static import, so the ~0.3 MB runtime and (more
 *    importantly) any wasm glue stay out of the entry chunk.
 *  - The wasm runtime is self-hosted: `env.wasm.wasmPaths` points at the
 *    same-origin `public/ocr/ort/` directory produced by `npm run assets:ocr`.
 *    Vite must resolve the *extern* onnxruntime-web build (the
 *    `onnxruntime-web-use-extern-wasm` condition in vite.config.ts) or it will
 *    instead inline a `new URL('...wasm', import.meta.url)` and emit a duplicate
 *    ~14 MB `dist/assets/*.wasm`.
 *  - GitHub Pages cannot send COOP/COEP, so multithreaded wasm is unavailable:
 *    force `numThreads = 1` with SIMD on and the worker proxy off.
 *  - `warmUp()` is idempotent and shares one in-flight promise across
 *    concurrent callers; `dispose()` is idempotent and guarantees no closure
 *    state is written after it runs, even when initialization resolves late.
 *
 * The model output `softmax_5.tmp_0` is `[1, T, C]` already softmaxed; decoding
 * is delegated to {@link greedyCtcDecode} and the dictionary to
 * {@link parseDict}, so this module only owns session/tensor plumbing.
 */

import { OCR_ASSETS } from './assets.ts'
import { parseDict } from './dict.ts'
import { buildRecTensor, REC_DIMS } from './preprocess.ts'
import { greedyCtcDecode } from './recDecode.ts'
import type { RawImage } from './preprocess.ts'

export type OcrResult = { text: string; score: number; charScores: number[] }

export interface OcrEngine {
  isReady(): boolean
  warmUp(): Promise<void>
  recognize(image: RawImage): Promise<OcrResult>
  dispose(): Promise<void>
}

/** Constructor/session option surface actually used from onnxruntime-web. */
type OrtTensor = {
  readonly data: Float32Array
  readonly dims: readonly number[]
  dispose?(): void
}

type OrtSession = {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, unknown>>
  release(): Promise<void>
}

type OrtModule = {
  env: {
    wasm: {
      numThreads?: number
      simd?: boolean | 'fixed' | 'relaxed'
      proxy?: boolean
      wasmPaths?: string
    }
  }
  Tensor: new (
    type: 'float32',
    data: Float32Array,
    dims?: readonly number[],
  ) => OrtTensor
  InferenceSession: {
    create(
      uri: string,
      options?: Record<string, unknown>,
    ): Promise<OrtSession>
  }
}

/**
 * Module-level cache of the dynamic import. `onnxruntime-web/wasm` is a heavy
 * ESM module and the browser already caches the network fetch; caching the
 * resolved namespace here avoids re-running the `mod.default` unwrapping too.
 * A rejected import is evicted so a transient failure can be retried.
 */
let ortPromise: Promise<OrtModule> | null = null

function loadOrt(): Promise<OrtModule> {
  if (ortPromise) return ortPromise
  const task = import('onnxruntime-web/wasm').then(resolveOrt)
  ortPromise = task
  task.catch(() => {
    if (ortPromise === task) ortPromise = null
  })
  return task
}

/**
 * Accept either shape the bundler may hand back: the named ESM exports
 * (`env`, `Tensor`, `InferenceSession`) or a default-exported namespace.
 */
function resolveOrt(mod: unknown): OrtModule {
  const candidate = mod as { default?: unknown }
  if (hasOrtApi(candidate)) return candidate
  if (hasOrtApi(candidate.default)) return candidate.default
  throw new Error(
    'onnxruntime-web/wasm did not expose env, Tensor and InferenceSession',
  )
}

function hasOrtApi(value: unknown): value is OrtModule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<OrtModule>
  return (
    typeof candidate.Tensor === 'function' &&
    typeof candidate.env === 'object' &&
    candidate.env !== null &&
    typeof candidate.InferenceSession?.create === 'function'
  )
}

/** Ensure a directory-style wasm path ends with `/` (ort resolves files from it). */
function asDirectory(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

async function loadDict(url: string): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (err) {
    throw new Error(`Failed to fetch the OCR dictionary from ${url}`, {
      cause: err,
    })
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch the OCR dictionary from ${url}: HTTP ${response.status}`,
    )
  }
  return parseDict(await response.text())
}

async function createSession(
  ort: OrtModule,
  modelUrl: string,
): Promise<OrtSession> {
  try {
    return await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (err) {
    throw new Error(`Failed to load the OCR recognition model from ${modelUrl}`, {
      cause: err,
    })
  }
}

async function safeRelease(target: OrtSession): Promise<void> {
  try {
    await target.release()
  } catch {
    // Releasing a partially-initialized session can throw; cleanup is best-effort.
  }
}

function disposeValue(value: { dispose?(): void } | undefined): void {
  if (!value || typeof value.dispose !== 'function') return
  try {
    value.dispose()
  } catch {
    // Tensor disposal is best-effort; the GC reclaims anything left behind.
  }
}

export function createOcrEngine(opts?: {
  recModelUrl?: string
  dictUrl?: string
  wasmDir?: string
}): OcrEngine {
  const modelUrl = opts?.recModelUrl ?? OCR_ASSETS.recModel
  const dictUrl = opts?.dictUrl ?? OCR_ASSETS.dict
  const wasmDir = asDirectory(opts?.wasmDir ?? OCR_ASSETS.ortDir)

  let ort: OrtModule | null = null
  let session: OrtSession | null = null
  let dict: string[] | null = null
  let inputName = 'x'
  let outputName: string | null = null
  let ready = false
  let configured = false
  let disposed = false
  let generation = 0
  let initPromise: Promise<void> | null = null

  /**
   * Apply the wasm flags exactly once per engine, before any session is
   * created. Multithreading is unusable on GitHub Pages (no COOP/COEP).
   */
  function configure(mod: OrtModule): void {
    if (configured) return
    mod.env.wasm.numThreads = 1
    mod.env.wasm.simd = true
    mod.env.wasm.proxy = false
    mod.env.wasm.wasmPaths = wasmDir
    configured = true
  }

  async function initialize(token: number): Promise<void> {
    const mod = await loadOrt()
    if (disposed || token !== generation) {
      throw new Error('OCR engine was disposed during warm-up')
    }
    configure(mod)

    // Load sequentially: the dictionary first, then the model session.
    // Creating both in parallel would orphan the InferenceSession if the dict
    // fetch rejected while/after the session had already been created — the
    // session is only reachable via the local once this function publishes it,
    // so dispose() could never release it and every retry would leak ~10 MB.
    // Awaiting the dict first makes the dict-failure path session-free.
    const loadedDict = await loadDict(dictUrl)

    // dispose() may have run while the dict was loading: bail out before
    // creating a session that would immediately be discarded.
    if (disposed || token !== generation) {
      throw new Error('OCR engine was disposed during warm-up')
    }

    const created = await createSession(mod, modelUrl)

    // dispose() may have run while the session was being created: publish
    // nothing and release the session we just created.
    if (disposed || token !== generation) {
      await safeRelease(created)
      throw new Error('OCR engine was disposed during warm-up')
    }

    const createdOutput = created.outputNames[0]
    if (createdOutput === undefined) {
      await safeRelease(created)
      throw new Error('OCR recognition model exposes no output tensor')
    }

    ort = mod
    session = created
    dict = loadedDict
    inputName = created.inputNames[0] ?? 'x'
    outputName = createdOutput
    ready = true
  }

  function warmUp(): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error('OCR engine has been disposed'))
    }
    if (ready) return Promise.resolve()
    if (initPromise) return initPromise

    const token = generation
    const task = initialize(token)
    initPromise = task
    const clear = (): void => {
      if (initPromise === task) initPromise = null
    }
    void task.then(clear, clear)
    return task
  }

  function isReady(): boolean {
    return ready && !disposed
  }

  async function recognize(image: RawImage): Promise<OcrResult> {
    if (disposed) throw new Error('OCR engine has been disposed')
    await warmUp()
    if (disposed) {
      throw new Error('OCR engine was disposed before recognition')
    }

    const activeOrt = ort
    const activeSession = session
    const activeDict = dict
    const activeInput = inputName
    const activeOutput = outputName
    if (!activeOrt || !activeSession || !activeDict || !activeOutput) {
      throw new Error('OCR engine is not initialized')
    }

    const tensor = new activeOrt.Tensor('float32', buildRecTensor(image), REC_DIMS)
    let outputs: Record<string, unknown>
    try {
      outputs = await activeSession.run({ [activeInput]: tensor })
    } catch (err) {
      throw new Error('OCR recognition inference failed', { cause: err })
    } finally {
      disposeValue(tensor)
    }

    const outValue = outputs[activeOutput] as
      | { data: Float32Array; dims: readonly number[]; dispose?(): void }
      | undefined
    if (!outValue || !(outValue.data instanceof Float32Array)) {
      throw new Error('OCR recognition model returned no float32 output tensor')
    }

    let decoded: OcrResult
    try {
      decoded = greedyCtcDecode(outValue.data, outValue.dims, activeDict)
    } finally {
      disposeValue(outValue)
    }

    if (disposed) {
      throw new Error('OCR engine was disposed during recognition')
    }
    return decoded
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    // Invalidate any in-flight initialize so it discards its late results.
    generation += 1
    ready = false
    initPromise = null

    const activeSession = session
    session = null
    dict = null
    ort = null
    outputName = null
    inputName = 'x'

    if (activeSession) await safeRelease(activeSession)
  }

  return { isReady, warmUp, recognize, dispose }
}
