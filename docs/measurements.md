# Price Converter — Production Measurements (blueprint §6.5)

**Date:** 2026-10-06
**Scope:** `price-converter` production `dist/` artifact (Vite 8, React 19, tesseract.js 7.0.0).

## 1. Measurement method

All byte figures below are emitted by `scripts/verify-artifact.mjs` (T7), run after a full
production build. The script classifies each JS/CSS asset by chunk role (entry / initial /
lazy / css) using the emitted import graph, then compresses every asset with Node's `zlib`:

- **gzip:** `zlib.gzipSync(buffer, { level: 9 })` (maximum deflate).
- **brotli:** `zlib.brotliCompressSync(buffer, { [BROTLI_PARAM_QUALITY]: 11 })` (maximum quality).
- **raw:** on-disk file size in bytes.

Sizes are uncompressed file bytes / gzip bytes / brotli bytes. `dist/ocr/**` and `dist/**` are
raw directory totals (not re-compressed). The script is read-only with respect to `dist/`.

Exact reproduction command:

```bash
npm run assets:ocr && npm run build && node scripts/verify-artifact.mjs
```

On 2026-10-06 this run reported **58 passed / 0 failed** (`verify-artifact: PASS — all artifact
assertions satisfied`) and the MEASUREMENTS block reproduced the numbers in this report verbatim.

## 2. First-load bytes

First load is the app shell only. Tesseract.js, its worker/core, and language data are **not**
first-load: they are dynamically imported and fetched only when the scanner opens.

| File | Role | raw (B) | gzip (B) | brotli (B) |
| --- | --- | ---: | ---: | ---: |
| `assets/index-BYB6JahH.js` | entry | 248,399 | 77,117 | 66,530 |
| `assets/rolldown-runtime-C0FnF6B9.js` | initial | 1,291 | 712 | 621 |
| **Initial JS total (entry + static)** | | **249,690** | **77,829** | **67,151** |
| `assets/index-CxcMpwR3.css` | css | 4,036 | 1,273 | 1,072 |
| **First-load total (initial JS + CSS)** | | **253,726** | **79,102** | **68,223** |

- Entry JS alone: **248,399 raw / 77,117 gzip / 66,530 brotli** (≈242.6 KiB / 75.3 KiB / 65.0 KiB).
- Initial JS total: **249,690 raw / 77,829 gzip / 67,151 brotli** (≈243.8 KiB / 76.0 KiB / 65.6 KiB).
- Initial CSS: **4,036 raw / 1,273 gzip / 1,072 brotli** (≈3.9 KiB / 1.2 KiB / 1.0 KiB).
- The lazy chunks (`ScanPanel`, `src` = tesseract.js library, `workbox-window`) are **not** part of
  first load. The chunk graph asserts "initial entry chunk has no tesseract reference" and
  "lazy scanner chunk(s) reference tesseract".
- The precache manifest does include the lazy JS chunks (see §4), so they are downloaded at
  service-worker install even if the user never scans; that cost is small (lazy JS total
  **38,486 raw / 14,558 gzip / 12,962 brotli**).

## 3. Deferred OCR bytes

OCR is deferred until the scanner first opens. tesseract.js detects device WASM features
(`wasm-feature-detect`) and fetches **exactly one** core variant pair plus the worker and language
data, then caches all of it for offline reuse.

### Shipped `dist/ocr/**` (8 files, 23,341,131 B ≈ 22.3 MiB)

| Asset | Path | Bytes | ≈ |
| --- | --- | ---: | ---: |
| Worker | `dist/ocr/worker.min.js` | 111,307 | 108.7 KiB |
| Core — non-SIMD glue | `dist/ocr/core/tesseract-core-lstm.wasm.js` | 3,896,484 | 3.72 MiB |
| Core — non-SIMD binary | `dist/ocr/core/tesseract-core-lstm.wasm` | 2,855,361 | 2.72 MiB |
| Core — SIMD glue | `dist/ocr/core/tesseract-core-simd-lstm.wasm.js` | 3,899,472 | 3.72 MiB |
| Core — SIMD binary | `dist/ocr/core/tesseract-core-simd-lstm.wasm` | 2,857,601 | 2.72 MiB |
| Core — relaxed-SIMD glue | `dist/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js` | 3,905,767 | 3.72 MiB |
| Core — relaxed-SIMD binary | `dist/ocr/core/tesseract-core-relaxedsimd-lstm.wasm` | 2,862,266 | 2.73 MiB |
| Language data | `dist/ocr/lang/eng.traineddata.gz` | 2,952,873 | 2.82 MiB |
| **`dist/ocr/**` total** | | **23,341,131** | **≈22.3 MiB** |

**Per-variant core totals** (glue `.wasm.js` + `.wasm`):

| Variant | Total bytes | ≈ |
| --- | ---: | ---: |
| non-SIMD `lstm` | 6,751,845 | 6.44 MiB |
| `simd-lstm` | 6,757,073 | 6.44 MiB |
| `relaxedsimd-lstm` | 6,768,033 | 6.45 MiB |

**Per-device download on first scan** = worker + one core pair + language data:

- relaxed-SIMD device (most current phones): 2,952,873 + 111,307 + 6,768,033 = **9,832,213 B ≈ 9.38 MiB**
- SIMD device: ≈ 9.37 MiB; non-SIMD device: ≈ 9.36 MiB

So although the artifact ships **≈22.3 MiB** of OCR, a given device actually fetches **≈9.4 MiB**
once. The three LSTM variants are only downloaded when the scanner first opens (one of them is
selected), and afterwards they are served from the `ocr-assets` CacheFirst runtime cache, offline.

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

- **Precache (shell):** 13 manifest entries / **12 distinct files**, totalling **329.18 KiB**
  (337,076 B of distinct content). Includes `index.html`, `manifest.webmanifest`, the 4 icons, and
  all hashed JS/CSS (including the 3 lazy chunks). `**/ocr/**` is explicitly excluded
  (`globIgnores`), enforced by verify-artifact ("precache EXCLUDES \*\*/ocr/\*\*").
  Note: `manifest.webmanifest` is listed twice in the generated precache array (13 entries vs 12
  files) — harmless but worth cleaning up.
- **OCR cache (`ocr-assets`, runtime):** `CacheFirst`, `maxEntries: 12`, `maxAgeSeconds: 365 d`,
  cacheable responses `[0, 200]`. The 8 `dist/ocr/**` files fit within 12 entries. Upper bound if
  every shipped OCR file were fetched is **23,341,131 B = 22.26 MiB ≈ 22.3 MiB** (the brief's
  "~22.8 MiB" is a decimal-KB→binary-MiB rounding of the same total); a normal device fetches
  **≈9.4 MiB** (one core variant pair + worker + language data).

### Quota / eviction risk

- localStorage and Cache Storage draw on the same origin storage quota. Chrome grants a large
  fraction of free disk; iOS Safari is far more constrained and applies aggressive eviction
  (e.g. roughly 7 days of site inactivity under ITP) and may clear cache entries without warning.
- The app calls `navigator.storage.persist()` (T14): `ScanPanel` fires it best-effort,
  non-blocking (the promise result is ignored) right after the first successful camera start, i.e.
  inside the existing user gesture. Persistence is only a hint the browser may deny, so the
  ~9.4 MiB OCR cache and shell remain evictable. Once evicted, the next scan re-downloads the
  ~9.4 MiB while online; offline scanning fails until then.
- `maxEntries: 12` exactly covers the current 8 OCR files. If more language files are added later,
  LRU eviction under this limit should be revisited.

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
  rolling window of the last `WINDOW_SIZE = 3` readings before a candidate is emitted (null/unparseable
  frames age the window rather than reset it), so time-to-candidate ≈ enough passes to reach 2
  agreements, separated by 200 ms gaps.
- **Frame input.** A WYSIWYG crop mapped from the on-screen guide (`computeCropRegion`, `object-fit:
  cover`) to source-video pixels is drawn to a canvas, preprocessed (grayscale → min/max contrast
  stretch → Otsu global threshold) and upscaled so the longest side is 600–1000 px (downscaled above
  1000 px), then passed directly to `worker.recognize` (never a JPEG data URL). PSM = `SINGLE_LINE`,
  char whitelist `0123456789.,`.
- **Cold vs warm.** First scan after opening the panel also pays worker creation, core fetch and
  compile, and the ~2.95 MiB language download (≈9.4 MiB total, §3). Later scans reuse the cached,
  already-initialized worker and only pay recognition.

### Measurement method (midrange phone, e.g. a Snapdragon 6-series Android, ~4 GB RAM)

1. Serve the production build over HTTPS at `/price-converter/` (a deploy or
   `vite preview --host` with a TLS tunnel), then open it in Chrome on the phone.
   **Clear site data first** to capture a cold first-scan measurement, then repeat warm.
2. Attach desktop DevTools via `chrome://inspect` (remote debugging).
3. **Recognize-pass timing (per frame):** in the Console or a DevTools snippet (no repo edits),
   wrap the call in User Timing:
   ```js
   const t0 = performance.now();
   await scanOnce();                 // or observe the promise returned by the loop's step()
   performance.measure('recognize', { start: t0, end: performance.now() });
   ```
   Because `scanOnce` is internal to the hook, the practical alternative is the **Performance
   panel**: Record, press "Start camera", and read the duration of each `worker.recognize`
   async task (worker/main-thread timeline) and the gap between successive recognitions.
4. **Time-to-first-candidate:** record from the "Start camera" tap until the "Detected" value first
   appears (includes worker init + first core/lang download on cold runs, plus the 2-confirmation
   gate).
5. **Sample size:** run ≥20 recognitions on the same label and on a few real labels (receipt,
   shelf tag) at different lighting/distance; report the **median** and **p95** separately for
   (a) single recognition pass, (b) time-to-first-candidate, and (c) cold vs warm.
6. Cross-check the JS-side timing against `performance.now()` deltas in the Console and against the
   phone's own perceived time to a stable candidate.

Fields to fill in on device (left blank on purpose — do not treat as measured):

| Metric | Cold (first ever scan) | Warm (cached) |
| --- | --- | --- |
| Single `recognize` pass, median / p95 | _to be measured_ | _to be measured_ |
| Time to first `Detected` candidate | _to be measured_ | _to be measured_ |
| Effective scan-loop period (recognize + 200 ms) | _to be measured_ | _to be measured_ |

**Unverified estimate (not a device result):** a single-line OCR pass on a ≤1000 px crop is
typically in the high-hundreds of milliseconds to low seconds on midrange hardware; with the 200 ms
gap and the 2-of-last-3 confirmation window, a stable candidate would generally appear within a few
seconds of holding the label steady. Confirm or replace with the on-device numbers above before
publishing performance claims.

## 6. Recommendation

### Prune the core variants? — Yes, with a required code change

Because tesseract.js selects the core file by device capability at runtime
(`wasm-feature-detect`: relaxed-SIMD → SIMD → plain), you **cannot** prune by deleting files alone:
a device that reports relaxed-SIMD would still request `tesseract-core-relaxedsimd-lstm.wasm.js`
and get a 404. To ship a single variant you must also point `corePath` at a specific `.wasm.js`
file (getCore.js honors a `corePath` ending in `js`).

- **Recommended (aggressive):** ship **SIMD-LSTM only**, pin `corePath` at
  `${OCR_BASE}core/tesseract-core-simd-lstm.wasm.js`, and drop the relaxed-SIMD and
  non-SIMD pairs. Shipped `dist/ocr/**` falls from 23,341,131 B to 9,821,253 B — a reduction of
  **13,519,878 B ≈ 12.9 MiB (≈13.5 MB)**, roughly 58% of the OCR payload. (The task brief's
  "~15 MiB" is a coarser rounding of the same change.)
  - **Tradeoff:** browsers without WASM SIMD (pre-2019 engines) lose on-device OCR and fall back to
    manual entry. WASM SIMD is widely available on current iOS/Android browsers, so the practical
    exposure is small but non-zero. Shipping SIMD (rather than relaxed-SIMD) is the safer single
    choice because SIMD has the broadest support of the two accelerated tiers.
- **Conservative alternative:** keep the current three files (no code change, no capability gap).
  Dropping only the `simd-lstm` pair (6,757,073 B ≈ 6.44 MiB) would cut the artifact in half but
  still breaks the narrow "SIMD yes / relaxed-SIMD no" tier (Chrome ~91–113 era), so it is not
  clearly better than keeping all three.

Given the app already degrades to manual entry when OCR is unavailable, the aggressive SIMD-LSTM
prune is the right default **once the on-device latency numbers in §5 confirm SIMD recognition is
acceptable**; revisit if old-device usage appears in telemetry.

### Caching changes from observed data

- Do not precache the OCR assets (the `**/ocr/**` glob is already correctly excluded). Keep the CacheFirst runtime route;
  its 8 files (or 4 after pruning) fit `maxEntries: 12`. After pruning, `maxEntries: 4` is
  sufficient and reduces worst-case growth.
- **Done (T14): `navigator.storage.persist()` is called** best-effort and non-blocking (the
  promise result is ignored) right after the first successful camera start, inside the existing
  user gesture, to reduce the chance of losing the ~9.4 MiB OCR cache to eviction, especially on
  iOS. The browser may still deny the request, so treat the cache as evictable.
- **De-duplicate `manifest.webmanifest`** in the precache manifest (13 entries → 12 files).
- **Optional:** exclude the three lazy JS chunks from precache if the goal is to minimize install
  bytes; they are only ~38.5 KiB raw / ~13 KiB brotli, so the benefit is marginal.

## 7. How to re-measure

1. Ensure OCR assets and a production build are current: `npm run assets:ocr && npm run build`.
2. Run the artifact assertions + measurement block (read-only on `dist/`):
   `node scripts/verify-artifact.mjs`
   - Expect `verify-artifact: PASS` with the per-file raw/gzip/brotli table and the
     `dist/ocr/**` / `dist/**` totals. Compression is fixed at gzip level 9 and brotli quality 11.
3. Confirm byte totals independently:
   - `find dist/ocr -type f -exec stat -c '%s %n' {} +` and sum.
   - `du -sb dist` / `find dist -type f | wc -l` for the artifact-wide totals.
4. Confirm precache composition: inspect the `precacheAndRoute([...])` array in `dist/sw.js`
   (entry count, distinct URLs, `ocr` absent) and confirm the `ocr-assets` CacheFirst route.
5. Re-run the on-device latency procedure in §5 after any change to the crop guide mapping, max
   dimension, PSM mode, core variant, or the 200 ms scan interval.
