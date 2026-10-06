#!/usr/bin/env node
/**
 * Copy the deterministic offline OCR assets into public/ocr/.
 *
 * Idempotent (copies overwrite and stale paths are removed) and fails loudly if
 * any source is missing or if a vendored source's sha256 does not match the
 * pinned provenance hash. Run via `npm run assets:ocr`; the Stage 3 scanner
 * consumes the layout through src/lib/ocr/assets.ts.
 *
 * Sources:
 *   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs
 *   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm
 *   vendor/ocr/ch_PP-OCRv3_rec_infer.onnx
 *   vendor/ocr/ppocr_keys_v1.txt
 *
 * Layout produced:
 *   public/ocr/ort/ort-wasm-simd-threaded.mjs
 *   public/ocr/ort/ort-wasm-simd-threaded.wasm
 *   public/ocr/models/ch_PP-OCRv3_rec_infer.onnx
 *   public/ocr/dict/ppocr_keys_v1.txt
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const nodeModules = path.join(projectRoot, 'node_modules')
const vendorDir = path.join(projectRoot, 'vendor', 'ocr')
const ocrDir = path.join(projectRoot, 'public', 'ocr')

const ortDist = path.join(nodeModules, 'onnxruntime-web', 'dist')

// Provenance: the vendored model/dict are redistributed byte-for-byte, so pin
// their hashes and fail loudly if a source is swapped or corrupted.
const REC_MODEL_SHA256 =
  '897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615'
const DICT_SHA256 =
  '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7'

const copies = [
  {
    from: path.join(ortDist, 'ort-wasm-simd-threaded.mjs'),
    to: path.join(ocrDir, 'ort', 'ort-wasm-simd-threaded.mjs'),
  },
  {
    from: path.join(ortDist, 'ort-wasm-simd-threaded.wasm'),
    to: path.join(ocrDir, 'ort', 'ort-wasm-simd-threaded.wasm'),
  },
  {
    from: path.join(vendorDir, 'ch_PP-OCRv3_rec_infer.onnx'),
    to: path.join(ocrDir, 'models', 'ch_PP-OCRv3_rec_infer.onnx'),
    sha256: REC_MODEL_SHA256,
  },
  {
    from: path.join(vendorDir, 'ppocr_keys_v1.txt'),
    to: path.join(ocrDir, 'dict', 'ppocr_keys_v1.txt'),
    sha256: DICT_SHA256,
  },
]

/**
 * Tesseract-era runtime paths (Stage 3 replaced tesseract.js). Remove them if a
 * dirty working tree left them behind, so they can never ship in `dist/`.
 */
const stalePaths = [
  path.join(ocrDir, 'worker.min.js'),
  path.join(ocrDir, 'core'),
  path.join(ocrDir, 'lang'),
]

async function sha256(filePath) {
  const bytes = await readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

async function removeStale() {
  for (const stale of stalePaths) {
    try {
      await stat(stale)
    } catch {
      continue // Absent: nothing to clean up (keeps the script idempotent).
    }
    await rm(stale, { recursive: true, force: true })
    console.log(
      `Removed stale tesseract-era path: ${path.relative(projectRoot, stale)}`,
    )
  }
}

async function main() {
  await removeStale()

  let total = 0

  for (const { from, to, sha256: expectedHash } of copies) {
    let source
    try {
      source = await stat(from)
    } catch {
      throw new Error(`missing OCR source file: ${path.relative(projectRoot, from)}`)
    }
    if (!source.isFile()) {
      throw new Error(`OCR source is not a file: ${path.relative(projectRoot, from)}`)
    }

    if (expectedHash) {
      const actualHash = await sha256(from)
      if (actualHash !== expectedHash) {
        throw new Error(
          `sha256 mismatch for ${path.relative(projectRoot, from)}: expected ${expectedHash}, got ${actualHash}`,
        )
      }
    }

    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)

    const written = (await stat(to)).size
    total += written
    console.log(
      `${path.relative(projectRoot, to)} <- ${path.relative(projectRoot, from)} (${written} bytes)`,
    )
  }

  console.log(
    `Copied ${copies.length} OCR assets (${total} bytes) into public/ocr/.`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
