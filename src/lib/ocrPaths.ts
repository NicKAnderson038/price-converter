/**
 * Frozen asset-path contract for the offline OCR scanner (consumed by T5).
 *
 * These paths must match the layout produced by `npm run assets:ocr`:
 *   public/ocr/worker.min.js
 *   public/ocr/core/tesseract-core[-simd|-relaxedsimd]-lstm.wasm[.js]
 *   public/ocr/lang/eng.traineddata.gz
 *
 * `corePath` and `langPath` are directories; tesseract.js resolves the
 * variant files itself when given a directory. Do not rename these keys.
 */
export const OCR_BASE = `${import.meta.env.BASE_URL}ocr/`

export const OCR_PATHS = {
  workerPath: `${OCR_BASE}worker.min.js`,
  corePath: `${OCR_BASE}core`,
  langPath: `${OCR_BASE}lang`,
} as const
