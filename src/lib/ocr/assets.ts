/**
 * Frozen asset-path contract for the offline OCR scanner (consumed by the
 * Stage 3 engine and scanner).
 *
 * These paths must match the layout produced by `npm run assets:ocr`:
 *   public/ocr/ort/ort-wasm-simd-threaded.mjs
 *   public/ocr/ort/ort-wasm-simd-threaded.wasm
 *   public/ocr/models/ch_PP-OCRv3_rec_infer.onnx
 *   public/ocr/dict/ppocr_keys_v1.txt
 *
 * `ortDir` is a directory prefix; onnxruntime-web resolves the wasm/glue
 * variant files itself when given a directory.
 */
export const OCR_BASE = `${import.meta.env.BASE_URL}ocr/`

export const OCR_ASSETS = {
  recModel: `${OCR_BASE}models/ch_PP-OCRv3_rec_infer.onnx`,
  dict: `${OCR_BASE}dict/ppocr_keys_v1.txt`,
  ortDir: `${OCR_BASE}ort/`,
} as const
