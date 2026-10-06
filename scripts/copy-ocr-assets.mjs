#!/usr/bin/env node
/**
 * Copy the deterministic offline OCR assets from node_modules into public/ocr/.
 *
 * Idempotent (copies overwrite) and fails loudly if any source is missing.
 * Run via `npm run assets:ocr`; the T5 scanner consumes the layout through
 * src/lib/ocrPaths.ts.
 *
 * Layout:
 *   public/ocr/worker.min.js
 *   public/ocr/core/tesseract-core-{lstm,simd-lstm,relaxedsimd-lstm}.wasm.js
 *   public/ocr/core/tesseract-core-{lstm,simd-lstm,relaxedsimd-lstm}.wasm
 *   public/ocr/lang/eng.traineddata.gz
 *
 * tesseract.js selects `tesseract-core[-simd|-relaxedsimd]-lstm.wasm.js` when
 * corePath is a directory (node_modules/tesseract.js/src/worker-script/browser/getCore.js),
 * so all three LSTM-only glue variants and their binaries must be present.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const nodeModules = path.join(projectRoot, 'node_modules')
const ocrDir = path.join(projectRoot, 'public', 'ocr')
const coreSrcDir = path.join(nodeModules, 'tesseract.js-core')

const LSTM_CORE_VARIANTS = ['lstm', 'simd-lstm', 'relaxedsimd-lstm']

const copies = [
  {
    from: path.join(nodeModules, 'tesseract.js', 'dist', 'worker.min.js'),
    to: path.join(ocrDir, 'worker.min.js'),
  },
  ...LSTM_CORE_VARIANTS.flatMap((variant) => {
    const base = `tesseract-core-${variant}`
    return [
      {
        from: path.join(coreSrcDir, `${base}.wasm.js`),
        to: path.join(ocrDir, 'core', `${base}.wasm.js`),
      },
      {
        from: path.join(coreSrcDir, `${base}.wasm`),
        to: path.join(ocrDir, 'core', `${base}.wasm`),
      },
    ]
  }),
  {
    from: path.join(
      nodeModules,
      '@tesseract.js-data',
      'eng',
      '4.0.0_best_int',
      'eng.traineddata.gz',
    ),
    to: path.join(ocrDir, 'lang', 'eng.traineddata.gz'),
  },
]

async function main() {
  let total = 0

  for (const { from, to } of copies) {
    let source
    try {
      source = await stat(from)
    } catch {
      throw new Error(`missing OCR source file: ${path.relative(projectRoot, from)}`)
    }
    if (!source.isFile()) {
      throw new Error(`OCR source is not a file: ${path.relative(projectRoot, from)}`)
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
