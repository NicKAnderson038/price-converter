#!/usr/bin/env node
/**
 * Production artifact assertions for the Price Converter (T7).
 *
 * Verifies the `dist/` produced by `npm run build` (+ `npm run assets:ocr`):
 * PWA manifest/icons, service worker + externalized workbox chunk, OCR runtime
 * asset layout, base-scoped asset URLs, no test tooling leakage, correct
 * precache/runtime-cache split (ocr must NOT be precached), and prints a
 * compression MEASUREMENTS block for the measurement task.
 *
 * Plain Node ESM, no new dependencies. Run after a build:
 *   node scripts/verify-artifact.mjs
 *
 * Exits non-zero with a clear message on the first-class failed assertion is
 * avoided on purpose: every assertion is evaluated and reported, then the
 * process exits 1 if any failed.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist')
const assetsDir = path.join(distDir, 'assets')

const BASE = '/price-converter/'

const failures = []
const passes = []

function check(name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(detail ? `${name} — ${detail}` : name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function exists(filePath) {
  try {
    const info = await stat(filePath)
    return info
  } catch {
    return null
  }
}

async function readUtf8(filePath) {
  return readFile(filePath, 'utf8')
}

/** Recursively list files (posix-relative to `root`). */
async function walkFiles(root, dir = root) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, full)))
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  return out
}

async function dirBytes(root) {
  const files = await walkFiles(root)
  let total = 0
  for (const rel of files) {
    total += (await stat(path.join(root, rel))).size
  }
  return { total, files }
}

function fmt(bytes) {
  return `${bytes} B (${(bytes / 1024).toFixed(1)} KiB)`
}

function pad(value, width) {
  const s = String(value)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

// ---------------------------------------------------------------------------
// 1. Top-level shell files
// ---------------------------------------------------------------------------

async function checkShell() {
  console.log('\n[shell]')
  const indexPath = path.join(distDir, 'index.html')
  const indexInfo = await exists(indexPath)
  check('dist/index.html exists at top level', indexInfo?.isFile() === true)

  const manifestPath = path.join(distDir, 'manifest.webmanifest')
  const manifestInfo = await exists(manifestPath)
  check('dist/manifest.webmanifest exists', manifestInfo?.isFile() === true)

  const swInfo = await exists(path.join(distDir, 'sw.js'))
  check('dist/sw.js exists', swInfo?.isFile() === true)

  return indexInfo ? readUtf8(indexPath) : null
}

// ---------------------------------------------------------------------------
// 2. Web manifest
// ---------------------------------------------------------------------------

async function checkManifest() {
  console.log('\n[manifest]')
  const manifestPath = path.join(distDir, 'manifest.webmanifest')
  let raw
  try {
    raw = await readUtf8(manifestPath)
  } catch {
    return
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    check('manifest parses as JSON', false, error.message)
    return
  }
  check('manifest parses as JSON', true)

  for (const field of ['id', 'start_url', 'scope']) {
    const value = manifest[field]
    check(
      `manifest.${field} starts with "${BASE}"`,
      typeof value === 'string' && value.startsWith(BASE),
      `got ${JSON.stringify(value)}`,
    )
  }

  check(
    'manifest.display is "standalone"',
    manifest.display === 'standalone',
    `got ${JSON.stringify(manifest.display)}`,
  )

  const icons = Array.isArray(manifest.icons) ? manifest.icons : []
  check('manifest declares 4 icons', icons.length === 4, `got ${icons.length}`)

  const findIcon = (predicate) => icons.find(predicate)

  const icon192 = findIcon(
    (i) =>
      typeof i.src === 'string' &&
      i.src.endsWith('/icons/icon-192.png') &&
      i.sizes === '192x192' &&
      i.type === 'image/png' &&
      String(i.purpose ?? 'any').includes('any'),
  )
  check('manifest has 192x192 any PNG icon', Boolean(icon192), JSON.stringify(icons))

  const icon512 = findIcon(
    (i) =>
      typeof i.src === 'string' &&
      i.src.endsWith('/icons/icon-512.png') &&
      i.sizes === '512x512' &&
      i.type === 'image/png' &&
      String(i.purpose ?? 'any').includes('any'),
  )
  check('manifest has 512x512 any PNG icon', Boolean(icon512), JSON.stringify(icons))

  const icon512Maskable = findIcon(
    (i) =>
      typeof i.src === 'string' &&
      i.src.endsWith('/icons/icon-512-maskable.png') &&
      i.sizes === '512x512' &&
      i.type === 'image/png' &&
      String(i.purpose ?? '').includes('maskable'),
  )
  check(
    'manifest has 512x512 maskable PNG icon',
    Boolean(icon512Maskable),
    JSON.stringify(icons),
  )

  const iconSvg = findIcon(
    (i) =>
      typeof i.src === 'string' &&
      i.src.endsWith('/icons/currency-scan-icon.svg') &&
      i.type === 'image/svg+xml',
  )
  check('manifest has SVG icon', Boolean(iconSvg), JSON.stringify(icons))

  // Every icon src must live under the deploy base (same-origin).
  const iconBaseOk = icons.every(
    (i) => typeof i.src === 'string' && i.src.startsWith(BASE),
  )
  check('all manifest icons are under the base path', iconBaseOk)
}

// ---------------------------------------------------------------------------
// 3. Service worker + externalized workbox chunk
// ---------------------------------------------------------------------------

async function checkServiceWorker() {
  console.log('\n[service worker]')
  const swPath = path.join(distDir, 'sw.js')
  const swInfo = await exists(swPath)
  if (!swInfo) return null

  const sw = await readUtf8(swPath)

  // First `define([...])` import emitted by workbox-build.
  const defineMatch = sw.match(/\bdefine\(\s*\[([^\]]*)\]/)
  check('sw.js contains a define() import', Boolean(defineMatch))
  if (!defineMatch) return { sw, precacheUrls: [] }

  const moduleRefs = defineMatch[1]
    .split(',')
    .map((token) => token.trim().replace(/^["'`]|["'`]$/g, ''))
    .filter(Boolean)
  check('sw.js define() imports at least one local module', moduleRefs.length > 0)

  for (const ref of moduleRefs) {
    const candidates = []
    if (ref.startsWith('.')) {
      candidates.push(path.resolve(distDir, ref))
      candidates.push(path.resolve(distDir, `${ref}.js`))
    } else {
      candidates.push(path.resolve(distDir, ref))
      candidates.push(path.resolve(distDir, `${ref}.js`))
    }
    let resolved = null
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        resolved = candidate
        break
      }
    }
    check(
      `referenced workbox chunk exists: ${ref}`,
      Boolean(resolved),
      `no local file for define import ${ref}`,
    )
  }

  // No broken / unexternalized workbox internals (workbox-core/_private style).
  const unexternalized = /workbox-core\/_private|_private\/|workbox-core\//.test(sw)
  check(
    'sw.js has no unexternalized workbox-core/_private imports',
    !unexternalized,
  )

  // Any importScripts() must not point at an unresolved workbox internal.
  const importScriptsRefs = [...sw.matchAll(/importScripts\(\s*["'`]([^"'`]+)["'`]/g)].map(
    (m) => m[1],
  )
  const brokenImportScripts = importScriptsRefs.filter((ref) =>
    /workbox-(core|routing|strategies|precaching|expiration|background-sync|broadcast-update|range-requests|cacheable-response|google-analytics)/.test(
      ref,
    ),
  )
  check(
    'sw.js importScripts() has no unresolved workbox internals',
    brokenImportScripts.length === 0,
    brokenImportScripts.join(', '),
  )

  return { sw, moduleRefs, importScriptsRefs }
}

// ---------------------------------------------------------------------------
// 4. OCR + icon asset layout
// ---------------------------------------------------------------------------

async function checkAssets() {
  console.log('\n[assets: icons + ocr]')

  const iconDir = path.join(distDir, 'icons')
  for (const file of [
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'currency-scan-icon.svg',
  ]) {
    const info = await exists(path.join(iconDir, file))
    check(`dist/icons/${file} exists`, info?.isFile() === true)
  }

  // Stage 3 layout: PP-OCRv3 rec ONNX + dict + self-hosted onnxruntime-web.
  const ocrDir = path.join(distDir, 'ocr')

  const recModelPath = path.join(ocrDir, 'models', 'ch_PP-OCRv3_rec_infer.onnx')
  const recModel = await exists(recModelPath)
  check(
    'dist/ocr/models/ch_PP-OCRv3_rec_infer.onnx exists',
    recModel?.isFile() === true,
  )
  check(
    'dist/ocr/models/ch_PP-OCRv3_rec_infer.onnx is >= 10,000,000 B',
    recModel?.isFile() === true && recModel.size >= 10_000_000,
    recModel ? `got ${recModel.size} B` : 'missing',
  )

  check(
    'dist/ocr/dict/ppocr_keys_v1.txt exists',
    (await exists(path.join(ocrDir, 'dict', 'ppocr_keys_v1.txt')))?.isFile() === true,
  )

  const ortWasmPath = path.join(ocrDir, 'ort', 'ort-wasm-simd-threaded.wasm')
  const ortWasm = await exists(ortWasmPath)
  check(
    'dist/ocr/ort/ort-wasm-simd-threaded.wasm exists',
    ortWasm?.isFile() === true,
  )
  check(
    'dist/ocr/ort/ort-wasm-simd-threaded.wasm is >= 10,000,000 B',
    ortWasm?.isFile() === true && ortWasm.size >= 10_000_000,
    ortWasm ? `got ${ortWasm.size} B` : 'missing',
  )

  check(
    'dist/ocr/ort/ort-wasm-simd-threaded.mjs exists',
    (await exists(path.join(ocrDir, 'ort', 'ort-wasm-simd-threaded.mjs')))?.isFile() === true,
  )

  // Tesseract-era paths must be gone entirely (Stage 3 removed tesseract.js).
  check(
    'dist/ocr/worker.min.js is absent (tesseract removed)',
    (await exists(path.join(ocrDir, 'worker.min.js'))) === null,
  )
  check(
    'dist/ocr/core/ is absent (tesseract removed)',
    (await exists(path.join(ocrDir, 'core'))) === null,
  )
  check(
    'dist/ocr/lang/ is absent (tesseract removed)',
    (await exists(path.join(ocrDir, 'lang'))) === null,
  )
}

// ---------------------------------------------------------------------------
// 5. index.html base-scoped references
// ---------------------------------------------------------------------------

async function checkIndexReferences(indexHtml) {
  console.log('\n[base path]')
  if (typeof indexHtml !== 'string') {
    indexHtml = await readUtf8(path.join(distDir, 'index.html')).catch(() => '')
  }

  const refs = [...indexHtml.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1])
  const localRefs = refs.filter(
    (ref) => !/^(?:#|data:|https?:|mailto:)/.test(ref),
  )
  const badRefs = localRefs.filter((ref) => !ref.startsWith(BASE))
  check(
    'index.html references assets under the base path',
    badRefs.length === 0,
    badRefs.join(', '),
  )

  const rootAbsolute = [...indexHtml.matchAll(/["'](\/assets\/[^"']*)["']/g)].map(
    (m) => m[1],
  )
  check(
    'index.html has no root-absolute /assets/... references',
    rootAbsolute.length === 0,
    rootAbsolute.join(', '),
  )
}

// ---------------------------------------------------------------------------
// 6. No test tooling leaked into the deploy artifact
// ---------------------------------------------------------------------------

async function checkNoTestLeakage() {
  console.log('\n[artifact hygiene]')
  const files = (await walkFiles(distDir)).filter((f) => f.endsWith('.js'))
  const forbidden = [
    { label: '@playwright', pattern: /@playwright/ },
    { label: 'test-results', pattern: /test-results/ },
    { label: 'node:test', pattern: /node:test/ },
  ]

  for (const { label, pattern } of forbidden) {
    const offenders = []
    for (const rel of files) {
      const content = await readUtf8(path.join(distDir, rel))
      if (pattern.test(content)) offenders.push(rel)
    }
    check(
      `no "${label}" in dist JS bundles`,
      offenders.length === 0,
      offenders.join(', '),
    )
  }
  check('scanned dist JS bundles for test leakage', files.length > 0, `files=${files.length}`)
}

// ---------------------------------------------------------------------------
// 7. Precache manifest: shell included, ocr excluded
// ---------------------------------------------------------------------------

function parsePrecacheUrls(sw) {
  const callMatch = sw.match(/precacheAndRoute\(\s*\[([\s\S]*?)\]\s*,/)
  if (!callMatch) return null
  return [...callMatch[1].matchAll(/\burl\s*:\s*["']([^"']+)["']/g)].map((m) => m[1])
}

async function checkPrecache(sw) {
  console.log('\n[precache]')
  const urls = parsePrecacheUrls(sw)
  check('sw.js contains a precache manifest', urls !== null)
  if (!urls) return
  check('precache manifest is non-empty', urls.length > 0, `entries=${urls.length}`)

  const has = (needle) => urls.includes(needle)
  check('precache includes index.html', has('index.html'))
  check('precache includes manifest.webmanifest', has('manifest.webmanifest'))

  for (const icon of [
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-512-maskable.png',
    'icons/currency-scan-icon.svg',
  ]) {
    check(`precache includes ${icon}`, has(icon))
  }

  const hashedJs = urls.filter((u) => /^assets\/.*\.js$/.test(u))
  const hashedCss = urls.filter((u) => /^assets\/.*\.css$/.test(u))
  check('precache includes hashed JS assets', hashedJs.length > 0, hashedJs.join(', '))
  check('precache includes hashed CSS assets', hashedCss.length > 0, hashedCss.join(', '))

  const ocrEntries = urls.filter((u) => /(^|\/)ocr\//.test(u) || /\*\*\/ocr\//.test(u))
  check(
    'precache EXCLUDES **/ocr/** (runtime-cached)',
    ocrEntries.length === 0,
    ocrEntries.join(', '),
  )

  const binaryEntries = urls.filter((u) => /\.(?:onnx|wasm)$/i.test(u))
  check(
    'precache includes no .onnx/.wasm assets',
    binaryEntries.length === 0,
    binaryEntries.join(', '),
  )

  // Duplicate-emit guard: the onnxruntime wasm must live only under
  // dist/ocr/ort/, never be re-emitted into the hashed assets dir.
  const strayWasm = []
  try {
    for (const name of await readdir(assetsDir)) {
      if (!name.endsWith('.wasm')) continue
      const info = await stat(path.join(assetsDir, name))
      if (info.size > 1_000_000) strayWasm.push(`${name} (${info.size} B)`)
    }
  } catch {
    // assets/ may be absent in a partial build; checkShell() covers the shell.
  }
  check(
    'no dist/assets/*.wasm larger than 1 MB (duplicate-emit guard)',
    strayWasm.length === 0,
    strayWasm.join(', '),
  )

  const missing = []
  for (const url of urls) {
    const local = path.join(distDir, url)
    if (!(await exists(local))) missing.push(url)
  }
  check(
    'every precache URL resolves to a dist file',
    missing.length === 0,
    missing.join(', '),
  )
}

// ---------------------------------------------------------------------------
// 8. Chunk graph, role classification, onnxruntime placement, OCR same-origin
// ---------------------------------------------------------------------------

function resolveAssetRef(fromFile, ref) {
  // ref may be "./name-hash.js" or "assets/name-hash.js"
  const clean = ref.replace(/^\.\//, '')
  const candidate = path.resolve(path.dirname(fromFile), clean)
  return candidate
}

async function buildChunkGraph(entryFile) {
  const entries = await readdir(assetsDir)
  const jsFiles = entries.filter((f) => f.endsWith('.js'))
  const abs = new Map(jsFiles.map((f) => [path.join(assetsDir, f), f]))

  const staticImports = new Map()
  const dynamicImports = new Map()
  for (const file of jsFiles) {
    const full = path.join(assetsDir, file)
    const content = await readUtf8(full)
    const staticRefs = new Set()
    for (const m of content.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
      const resolved = resolveAssetRef(full, m[1])
      if (abs.has(resolved)) staticRefs.add(resolved)
    }
    for (const m of content.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
      const resolved = resolveAssetRef(full, m[1])
      if (abs.has(resolved)) staticRefs.add(resolved)
    }
    const dynamicRefs = new Set()
    for (const m of content.matchAll(/\bimport\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g)) {
      const resolved = resolveAssetRef(full, m[1])
      if (abs.has(resolved)) dynamicRefs.add(resolved)
    }
    staticImports.set(full, staticRefs)
    dynamicImports.set(full, dynamicRefs)
  }

  // Entry file is the module script referenced by index.html.
  const entryFull = [...abs.keys()].find((k) => path.basename(k) === entryFile)
  const initial = new Set()
  if (entryFull) {
    const stack = [entryFull]
    while (stack.length) {
      const cur = stack.pop()
      if (initial.has(cur)) continue
      initial.add(cur)
      for (const dep of staticImports.get(cur) ?? []) stack.push(dep)
    }
  }

  const roles = new Map()
  for (const file of jsFiles) {
    const full = path.join(assetsDir, file)
    if (full === entryFull) roles.set(file, 'entry')
    else if (initial.has(full)) roles.set(file, 'initial')
    else roles.set(file, 'lazy')
  }

  return { jsFiles, roles, dynamicImports, staticImports, entryFull, abs }
}

async function checkChunkGraph(indexHtml) {
  console.log('\n[chunk graph]')
  const scriptMatch = indexHtml.match(
    /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/,
  )
  check('index.html has a module entry script', Boolean(scriptMatch))
  if (!scriptMatch) return

  const entryUrl = scriptMatch[1]
  check('entry script URL is under the base path', entryUrl.startsWith(BASE), entryUrl)
  // Recover the asset filename from the base-scoped URL.
  const entryFile = path.basename(entryUrl)
  const entryFull = path.join(assetsDir, entryFile)
  check(
    `entry script resolves to dist/assets/${entryFile}`,
    (await exists(entryFull))?.isFile() === true,
  )

  const graph = await buildChunkGraph(entryFile)
  check(
    'entry chunk classified as entry',
    graph.roles.get(entryFile) === 'entry',
    `got ${graph.roles.get(entryFile)}`,
  )

  // The OCR engine (onnxruntime-web) must stay out of the entry / initial
  // chunks; tesseract must be gone entirely.
  const initialEngine = []
  const lazyOnnx = []
  for (const [file, role] of graph.roles) {
    const content = await readUtf8(path.join(assetsDir, file))
    const bannedInInitial = /tesseract/i.test(content) || /onnxruntime/i.test(content)
    if (role === 'lazy') {
      if (/onnxruntime/i.test(content) || /ort-wasm/i.test(content)) lazyOnnx.push(file)
    } else if (bannedInInitial) {
      initialEngine.push(file)
    }
  }
  check(
    'initial entry/initial chunks have no tesseract or onnxruntime reference',
    initialEngine.length === 0,
    initialEngine.join(', '),
  )
  check(
    'lazy scanner chunk(s) reference onnxruntime/ort-wasm',
    lazyOnnx.length > 0,
    'no lazy chunk mentions onnxruntime or ort-wasm',
  )

  // The lazy scanner chunk(s) must load OCR from the same-origin base path.
  const lazyChunks = [...graph.roles.entries()]
    .filter(([, role]) => role === 'lazy')
    .map(([file]) => file)
  const lazyContents = new Map()
  for (const file of lazyChunks) {
    lazyContents.set(file, await readUtf8(path.join(assetsDir, file)))
  }

  // Collect URL-like string literals that mention OCR (root-absolute, relative,
  // or absolute). Every one must resolve under the deploy base `${BASE}ocr/`.
  const lazyOcrRefs = []
  for (const [file, content] of lazyContents) {
    for (const m of content.matchAll(
      /["'`]((?:https?:\/\/|\/|\.\.?\/)[^"'`\s]*ocr[^"'`\s]*)["'`]/gi,
    )) {
      lazyOcrRefs.push({ file, ref: m[1] })
    }
  }
  check(
    `lazy scanner chunk(s) resolve OCR under ${BASE}ocr/`,
    lazyOcrRefs.some(({ ref }) => ref.startsWith(`${BASE}ocr/`)),
    `no lazy chunk references ${BASE}ocr/`,
  )
  const badLazyOcrRefs = lazyOcrRefs.filter(
    ({ ref }) => !ref.startsWith(`${BASE}ocr/`),
  )
  check(
    `all lazy OCR asset URLs are under ${BASE}ocr/`,
    badLazyOcrRefs.length === 0,
    badLazyOcrRefs.map(({ file, ref }) => `${file}: ${ref}`).join(', '),
  )

  const crossOriginOcr = []
  for (const [file, content] of lazyContents) {
    for (const m of content.matchAll(
      /https?:\/\/[^"'`\s)]*(?:ocr|jsdelivr|huggingface|bcebos)[^"'`\s)]*/gi,
    )) {
      crossOriginOcr.push(`${file}: ${m[0]}`)
    }
  }
  check(
    'no lazy chunk references a cross-origin OCR/CDN URL',
    crossOriginOcr.length === 0,
    crossOriginOcr.join(', '),
  )

  return { graph, entryFile, lazyOnnx }
}

// ---------------------------------------------------------------------------
// MEASUREMENTS
// ---------------------------------------------------------------------------

function compressSizes(buffer) {
  const gzip = zlib.gzipSync(buffer, { level: 9 }).length
  const brotli = zlib.brotliCompressSync(buffer, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length
  return { raw: buffer.length, gzip, brotli }
}

async function printMeasurements(graph) {
  console.log('\n=== MEASUREMENTS ===')

  const entries = await readdir(assetsDir)
  const files = entries
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .sort()

  const order = { entry: 0, initial: 1, lazy: 2, css: 3 }
  const rows = []
  for (const file of files) {
    const buffer = await readFile(path.join(assetsDir, file))
    const sizes = compressSizes(buffer)
    const role = file.endsWith('.css') ? 'css' : (graph?.roles.get(file) ?? 'lazy')
    rows.push({ file, role, ...sizes })
  }
  rows.sort((a, b) => order[a.role] - order[b.role] || a.file.localeCompare(b.file))

  const nameWidth = Math.max(6, ...rows.map((r) => `assets/${r.file}`.length))
  console.log(
    `${pad('files', nameWidth)}  ${pad('role', 7)}  ${pad('raw', 12)}  ${pad('gzip', 12)}  ${pad('brotli', 12)}`,
  )
  for (const row of rows) {
    console.log(
      `${pad(`assets/${row.file}`, nameWidth)}  ${pad(row.role, 7)}  ${pad(row.raw, 12)}  ${pad(row.gzip, 12)}  ${pad(row.brotli, 12)}`,
    )
  }

  const initialRows = rows.filter(
    (r) => r.role === 'entry' || r.role === 'initial',
  )
  const lazyRows = rows.filter((r) => r.role === 'lazy')
  const sumRows = (subset) =>
    subset.reduce(
      (acc, r) => ({
        raw: acc.raw + r.raw,
        gzip: acc.gzip + r.gzip,
        brotli: acc.brotli + r.brotli,
      }),
      { raw: 0, gzip: 0, brotli: 0 },
    )
  const initial = sumRows(initialRows)
  const lazy = sumRows(lazyRows)
  const css = sumRows(rows.filter((r) => r.role === 'css'))

  const entryRow = rows.find((r) => r.role === 'entry')
  console.log('\n  Role legend: entry = index.html module script; initial = statically')
  console.log('  imported by entry (incl. modulepreload); lazy = dynamic import only; css.')
  if (entryRow) {
    console.log(
      `  Entry chunk: assets/${entryRow.file} — raw ${entryRow.raw}, gzip ${entryRow.gzip}, brotli ${entryRow.brotli}`,
    )
  }
  console.log(
    `  Initial JS (entry + static) total: raw ${initial.raw}, gzip ${initial.gzip}, brotli ${initial.brotli}`,
  )
  console.log(
    `  Lazy JS total: raw ${lazy.raw}, gzip ${lazy.gzip}, brotli ${lazy.brotli}`,
  )
  console.log(`  CSS total: raw ${css.raw}, gzip ${css.gzip}, brotli ${css.brotli}`)

  const ocrRoot = path.join(distDir, 'ocr')
  const ocr = await dirBytes(ocrRoot)
  console.log(`  dist/ocr/** total: ${fmt(ocr.total)} across ${ocr.files.length} files`)
  for (const sub of ['ort', 'models', 'dict']) {
    const subInfo = await exists(path.join(ocrRoot, sub))
    if (!subInfo?.isDirectory()) {
      console.log(`  dist/ocr/${sub}/: (absent)`)
      continue
    }
    const bytes = await dirBytes(path.join(ocrRoot, sub))
    console.log(
      `  dist/ocr/${sub}/: ${fmt(bytes.total)} across ${bytes.files.length} files`,
    )
  }
  const dist = await dirBytes(distDir)
  console.log(`  dist/** total: ${fmt(dist.total)} across ${dist.files.length} files`)
  console.log('=== END MEASUREMENTS ===')
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const distInfo = await exists(distDir)
  if (!distInfo?.isDirectory()) {
    console.error(`verify-artifact: dist/ not found at ${distDir}; run \`npm run build\` first.`)
    process.exit(1)
  }

  console.log('verify-artifact: production artifact assertions')
  console.log(`dist: ${distDir}`)

  const indexHtml = await checkShell()
  await checkManifest()
  const swResult = await checkServiceWorker()
  await checkAssets()
  await checkIndexReferences(indexHtml)
  await checkNoTestLeakage()
  if (swResult) await checkPrecache(swResult.sw)
  const graph = await checkChunkGraph(indexHtml ?? (await readUtf8(path.join(distDir, 'index.html')).catch(() => '')))

  await printMeasurements(graph?.graph)

  console.log('\n=== SUMMARY ===')
  console.log(`  passed: ${passes.length}`)
  console.log(`  failed: ${failures.length}`)
  if (failures.length > 0) {
    console.error('\nverify-artifact: FAILED')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nverify-artifact: PASS — all artifact assertions satisfied')
}

main().catch((error) => {
  console.error('\nverify-artifact: unexpected error')
  console.error(error)
  process.exit(1)
})
