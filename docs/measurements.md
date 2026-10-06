# Price Converter — Production Measurements (blueprint §6.5)

**Date:** 2026-10-06
**Scope:** `price-converter` production `dist/` artifact (Vite 8, React 19, PP-OCRv3
recognition via self-hosted `onnxruntime-web` 1.30).
**Provenance:** Stage 3 replaced tesseract.js with a self-hosted PP-OCRv3 ONNX engine
(rec-only), so the OCR sections below supersede the earlier engine's numbers.

## 1. Measurement method

All byte figures below are emitted by `scripts/verify-artifact.mjs` (T7, retargeted in
Stage 3), run after a full production build. The script classifies each JS/CSS asset by
chunk role (entry / initial / lazy / css) using the emitted import graph, then compresses
every asset with Node's `zlib`:

- **gzip:** `zlib.gzipSync(buffer, { level: 9 })` (maximum deflate).
- **brotli:** `zlib.brotliCompressSync(buffer, { [BROTLI_PARAM_QUALITY]: 11 })` (maximum quality).
- **raw:** on-disk file size in bytes.

Sizes are uncompressed file bytes / gzip bytes / brotli bytes. `dist/ocr/**` and `dist/**` are
raw directory totals (not re-compressed). The script is read-only with respect to `dist/`.

Exact reproduction command:

```bash
npm run assets:ocr && npm run build && node scripts/verify-artifact.mjs
```

On 2026-10-06 this run reported **61 passed / 0 failed** (`verify-artifact: PASS — all artifact
assertions satisfied`) and the MEASUREMENTS block reproduced the numbers in this report verbatim.

## 2. First-load bytes

First load is the app shell only. The ONNX OCR runtime and models are **not** first-load: the
`onnxruntime-web` extern chunk is a dynamic import and the OCR assets are fetched only when the
scanner opens.

| File | Role | raw (B) | gzip (B) | brotli (B) |
| --- | --- | ---: | ---: | ---: |
| `assets/index-DIRmgYyI.js` | entry | 251,395 | 77,940 | 67,366 |
| **Initial JS total (entry + static)** | | **251,395** | **77,940** | **67,366** |
| `assets/index-BHR2Gb_Z.css` | css | 4,676 | 1,415 | 1,201 |
| **First-load total (initial JS + CSS)** | | **256,071** | **79,355** | **68,567** |

- Entry JS alone: **251,395 raw / 77,940 gzip / 67,366 brotli** (≈245.5 KiB / 76.1 KiB / 65.8 KiB).
- Initial JS total: **251,395 raw / 77,940 gzip / 67,366 brotli** — entry only; the build emits no
  separate initial chunk.
- Initial CSS: **4,676 raw / 1,415 gzip / 1,201 brotli** (≈4.6 KiB / 1.4 KiB / 1.2 KiB).
- The lazy chunks (`ScanPanel`, the vendored onnxruntime-web extern runtime `ort.wasm.min`,
  `workbox-window`) are **not** part of first load. The chunk-graph assertions confirm the entry /
  initial chunks have **no onnxruntime reference** (and no OCR engine code at all) and that the lazy
  scanner chunk(s) reference onnxruntime/ort-wasm.
- The precache manifest does include the lazy JS chunks (see §4), so they are downloaded at
  service-worker install even if the user never scans; that cost is lazy JS total
  **75,144 raw / 25,038 gzip / 22,506 brotli** (≈73.4 KiB / 24.5 KiB / 22.0 KiB), of which the
  `ort.wasm.min` extern runtime is 48,063 raw / 15,261 gzip / 13,747 brotli.

## 3. Deferred OCR bytes

OCR is deferred until the scanner first opens. Unlike the retired per-device core selection, the
ONNX engine ships **one** ort wasm variant, so the full set below is downloaded and cached on the
first scan (then reused offline).

### Shipped `dist/ocr/**` (4 files, 24,981,279 B ≈ 23.82 MiB ≈ 24.98 MB)

| Asset | Path | Bytes | ≈ |
| --- | --- | ---: | ---: |
| Recognition model | `dist/ocr/models/ch_PP-OCRv3_rec_infer.onnx` | 10,690,752 | 10.19 MiB |
| Character dictionary | `dist/ocr/dict/ppocr_keys_v1.txt` | 26,249 | 25.6 KiB |
| ort wasm binary | `dist/ocr/ort/ort-wasm-simd-threaded.wasm` | 14,239,897 | 13.58 MiB |
| ort wasm glue | `dist/ocr/ort/ort-wasm-simd-threaded.mjs` | 24,381 | 23.8 KiB |
| **`dist/ocr/**` total** | | **24,981,279** | **≈23.82 MiB (≈24.98 MB)** |

Per-subdirectory totals from the MEASUREMENTS block:

| Directory | Bytes | Files |
| --- | ---: | ---: |
| `dist/ocr/ort/` | 14,264,278 | 2 |
| `dist/ocr/models/` | 10,690,752 | 1 |
| `dist/ocr/dict/` | 26,249 | 1 |

**Engine facts**

- **Recognition only:** PP-OCRv3 `ch_PP-OCRv3_rec_infer.onnx` (10,690,752 B, sha256
  `897a3e…` → full `897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615`) run through
  **onnxruntime-web@1.30**, self-hosted. Input `[1,3,48,W]` float32; output `softmax_5.tmp_0`
  shaped `[1,40,6625]` (T=40 max text length).
- **Dictionary:** `ppocr_keys_v1.txt` is 26,249 B / **6623 entries** (`wc -l` reports 6622 because
  the final line has no trailing newline). The decoder appends a single space at load time →
  **6624** entries, matching the model's **6625** classes = 1 CTC blank + 6624 glyphs
  (`dict[idx - 1]` for non-blank indices, index 0 = blank).
- **Runtime:** ort wasm **14,239,897 B** + glue **24,381 B** = 14,264,278 B; total `dist/ocr`
  **24,981,279 B ≈ 24.98 MB**.
- **Cache:** `/ocr/**` is served from the `ocr-assets` **CacheFirst** runtime cache, **not
  precached** (`globIgnores: ['**/ocr/**']`); `maxEntries: 12`, `maxAgeSeconds: 365 d`,
  cacheable responses `[0, 200]`.

**Constraints baked into this design**

- GitHub Pages cannot set COOP/COEP, so multithreaded wasm is unavailable: ort is forced
  **single-threaded** (`numThreads = 1`) with **WASM SIMD required**. Pre-SIMD browsers cannot run
  on-device OCR and fall back to **manual entry**.
- The wasm runtime is **self-hosted** under `/ocr/ort/` (no third-party OCR CDN at runtime).
- **Detection (DB) is deferred:** the engine is rec-only and reads the tight Stage-1 crop/guide
  band; it does not localize text boxes itself.

## 4. On-device storage

### localStorage (via `src/lib/storage.ts`)

The UI only touches storage through this module. Keys and approximate JSON payloads:

| Key | Record | Approx. JSON size |
| --- | --- | ---: |
| `price-converter.preferences.v1` | `Preferences` = `{schemaVersion:1, primaryCurrency, targetCurrency}` | ≈66 B (sample `{"schemaVersion":1,"primaryCurrency":"USD","targetCurrency":"EUR"}`) |
| `price-converter.rates.v1` | `RateSnapshot` = `{schemaVersion:1, provider:'frankfurter-v2', base:'USD', rates, rateDate, fetchedAt}` | ≈0.5–0.75 KiB (one numeric entry per published currency; a 54-code snapshot measured ≈748 B) |

Both are tiny (well under ~1 KiB JSON total; engines store localStorage as UTF-16, so roughly
double these byte counts). The module validates on read, swallows `QuotaExceededError`, and keeps
an in-memory `Map` fallback when persistent storage is unavailable. Typical localStorage quota is
~5 MiB per origin, so these records are not a quota concern.

### Cache Storage (service worker)

- **Precache (shell):** 12 manifest entries / **11 distinct files**, totalling **375,976 B**
  (≈367.2 KiB). Includes `index.html`, `manifest.webmanifest`, the 4 icons, and all 5 hashed
  JS/CSS assets (including the 3 lazy chunks). `**/ocr/**` is explicitly excluded
  (`globIgnores`), enforced by verify-artifact ("precache EXCLUDES \*\*/ocr/\*\*").
  Note: `manifest.webmanifest` is listed twice in the generated precache array (12 entries vs 11
  files) — harmless but worth cleaning up.
- **OCR cache (`ocr-assets`, runtime):** `CacheFirst`, `maxEntries: 12`, `maxAgeSeconds: 365 d`,
  cacheable responses `[0, 200]`. The 4 `dist/ocr/**` files fit within 12 entries. Upper bound if
  every shipped OCR file is fetched is **24,981,279 B = 23.82 MiB ≈ 24.98 MB**; because there is
  only one ort variant, a normal device fetches the full **≈24.98 MB** on its first scan.

### Quota / eviction risk

- localStorage and Cache Storage draw on the same origin storage quota. Chrome grants a large
  fraction of free disk; iOS Safari is far more constrained and applies aggressive eviction
  (e.g. roughly 7 days of site inactivity under ITP) and may clear cache entries without warning.
- The app calls `navigator.storage.persist()` (T14): `ScanPanel` fires it best-effort,
  non-blocking (the promise result is ignored) right after the first successful camera start, i.e.
  inside the existing user gesture. Persistence is only a hint the browser may deny, so the
  ~24.98 MB OCR cache and shell remain evictable. Once evicted, the next scan re-downloads the
  ~24.98 MB while online; offline scanning fails until then.
- `maxEntries: 12` comfortably covers the current 4 OCR files (it could be tightened to 4). If the
  deferred detection model is added later, revisit this limit.

## 5. Scan latency

No latency number in this report was measured on a physical device; treat the method below as the
measurement procedure and any range as a clearly labelled estimate.

### Relevant implementation facts (`src/lib/scanner.ts`, `src/components/ScanPanel.tsx`)

- **One recognition at a time.** `scanOnce()` sets an `inFlight` guard and rejects a concurrent
  call with `scan-busy` rather than queueing.
- **Scan loop throttle.** `ScanPanel` uses a recursive `setTimeout` (`SCAN_INTERVAL_MS = 200` ms),
  scheduling the next tick only after the previous `scanOnce()` settles. There is no `setInterval`.
  Effective loop period ≈ recognition time + 200 ms.
- **Confirmation gate.** A value must be observed at least `CONFIRMATIONS_REQUIRED = 2` times in a
  rolling window of the last `WINDOW_SIZE = 3` readings before a candidate is emitted
  (null/unparseable frames age the window rather than reset it), so time-to-candidate ≈ enough
  passes to reach 2 agreements, separated by 200 ms gaps.
- **Frame input.** The WYSIWYG crop mapped from the on-screen guide (`computeCropRegion`,
  `object-fit: cover`) to source-video pixels is drawn to a canvas, upscaled so the longest side is
  600–1000 px (downscaled above 1000 px), and passed as raw `ImageData` directly to
  `engine.recognize` (never a JPEG data URL). The Stage-1 crop/preprocessing still applies: the
  engine's `buildRecTensor` does grayscale → min/max contrast stretch → Otsu **ink-trim** (threshold
  used only to find the ink bounding box, ≥2px padding; pixels are not binarised) → bilinear resize
  to height 48 preserving aspect with width capped at 320 → right-pad to **48×320** → replicate the
  grayscale across RGB → normalize `x/127.5 - 1` into an NCHW float32 tensor. Amount candidates are
  then parsed from the decoded text by `parseAmount` (comma/dot rules); there is no separate
  recognition mode or character whitelist.
- **Cold vs warm.** The first scan after opening the panel also pays the dynamic ort import, wasm
  compile, and the **≈24.98 MB** model + dict + ort wasm download (§3). Later scans reuse the
  cached, already-initialized session and only pay inference + decode.

### Measurement method (midrange phone, e.g. a Snapdragon 6-series Android, ~4 GB RAM)

1. Serve the production build over HTTPS at `/price-converter/` (a deploy or
   `vite preview --host` with a TLS tunnel), then open it in Chrome on the phone.
   **Clear site data first** to capture a cold first-scan measurement, then repeat warm.
2. Attach desktop DevTools via `chrome://inspect` (remote debugging).
3. **Recognition-pass timing (per frame):** in the Console or a DevTools snippet (no repo edits),
   wrap the call in User Timing:
   ```js
   const t0 = performance.now();
   await scanOnce();                 // or observe the promise returned by the loop's step()
   performance.measure('recognize', { start: t0, end: performance.now() });
   ```
   Because `scanOnce` is internal to the hook, the practical alternative is the **Performance
   panel**: Record, press "Start camera", and read the duration of each `engine.recognize`
   (`session.run`) async task (main-thread; ort runs single-threaded with the proxy off) and the gap
   between successive recognitions.
4. **Time-to-first-candidate:** record from the "Start camera" tap until the "Detected" value first
   appears (includes session init + first model/dict/ort download on cold runs, plus the
   2-confirmation gate).
5. **Sample size:** run ≥20 recognitions on the same label and on a few real labels (receipt,
   shelf tag) at different lighting/distance; report the **median** and **p95** separately for
   (a) single recognition pass, (b) time-to-first-candidate, and (c) cold vs warm.
6. Cross-check the JS-side timing against `performance.now()` deltas in the Console and against the
   phone's own perceived time to a stable candidate.

Fields to fill in on device (left blank on purpose — do not treat as measured):

| Metric | Cold (first ever scan) | Warm (cached) |
| --- | --- | --- |
| Single recognition pass, median / p95 | _to be measured_ | _to be measured_ |
| Time to first `Detected` candidate | _to be measured_ | _to be measured_ |
| Effective scan-loop period (recognize + 200 ms) | _to be measured_ | _to be measured_ |

**Unverified estimate (not a device result):** a single-line rec pass on a 48×320 input is
typically in the high-tens to low-hundreds of milliseconds on midrange hardware; with the 200 ms
gap and the 2-of-last-3 confirmation window, a stable candidate would generally appear within a few
seconds of holding the label steady. Confirm or replace with the on-device numbers above before
publishing performance claims.

## 6. Recommendation

### OCR payload: no variant pruning to do; watch the fixed 24.98 MB

- The Stage-3 artifact ships exactly **one** ort wasm variant (`ort-wasm-simd-threaded.wasm` +
  `.mjs`), forced single-threaded. There is no per-device core selection and therefore nothing to
  prune: the rec model (10,690,752 B) and dictionary (26,249 B) are the only model payload, and both
  are required for rec-only. The ~24.98 MB `dist/ocr/**` is the intended, measured floor for this
  engine.
- **Pre-SIMD browsers must fall back to manual entry** (WASM SIMD is required). This is the same
  capability trade the previous engine accepted, but it can no longer be avoided by shipping fewer
  variants — it is a property of the single self-hosted wasm build.
- **Detection (DB) is deferred.** Adding `ch_PP-OCRv3_det_infer.onnx` (2,432,880 B) plus custom DB
  post-processing would let the engine localize the price band itself instead of relying on the
  Stage-1 crop guide, at the cost of a larger payload and new post-processing code. Revisit only if
  real-device accuracy on the rec-only band proves insufficient.

### Caching changes from observed data

- Do not precache the OCR assets (the `**/ocr/**` glob is already correctly excluded). Keep the
  CacheFirst runtime route; its 4 files fit comfortably within `maxEntries: 12` (tightening to 4 is
  sufficient).
- **Done (T14): `navigator.storage.persist()` is called** best-effort and non-blocking (the
  promise result is ignored) right after the first successful camera start, inside the existing
  user gesture, to reduce the chance of losing the ~24.98 MB OCR cache to eviction, especially on
  iOS. The browser may still deny the request, so treat the cache as evictable.
- **De-duplicate `manifest.webmanifest`** in the precache manifest (12 entries → 11 files).
- **Optional:** exclude the three lazy JS chunks from precache if the goal is to minimize install
  bytes; they are only ~73.4 KiB raw / ~22 KiB brotli, so the benefit is marginal.

## 7. How to re-measure

1. Ensure OCR assets and a production build are current: `npm run assets:ocr && npm run build`.
2. Run the artifact assertions + measurement block (read-only on `dist/`):
   `node scripts/verify-artifact.mjs`
   - Expect `verify-artifact: PASS` (61 assertions) with the per-file raw/gzip/brotli table and the
     `dist/ocr/**` / `dist/**` totals. Compression is fixed at gzip level 9 and brotli quality 11.
3. Confirm byte totals independently:
   - `find dist/ocr -type f -exec stat -c '%s %n' {} +` and sum.
   - `du -sb dist` / `find dist -type f | wc -l` for the artifact-wide totals.
4. Confirm precache composition: inspect the `precacheAndRoute([...])` array in `dist/sw.js`
   (entry count, distinct URLs, `ocr` absent) and confirm the `ocr-assets` CacheFirst route.
5. Re-run the on-device latency procedure in §5 after any change to the crop guide mapping, max
   dimension, rec input size/normalization (`buildRecTensor`), ort variant/flags, or the 200 ms scan
   interval.
