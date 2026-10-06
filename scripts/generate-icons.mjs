#!/usr/bin/env node
/**
 * Rasterize public/icons/currency-scan-icon.svg into the PWA PNG icons using
 * the already-installed Playwright Chromium (no new dependency).
 *
 * Outputs (committed to the repo; regenerate with `npm run icons` only when the
 * SVG master changes — this script needs Playwright):
 *   public/icons/icon-192.png           192x192  purpose "any"
 *   public/icons/icon-512.png           512x512  purpose "any"
 *   public/icons/icon-512-maskable.png  512x512  purpose "maskable"
 *
 * The maskable export scales the SVG master to 80% and centers it on an
 * opaque #071B3C background so the four currency symbols, scan corners, and
 * exchange arrows stay inside the central 80% safe circle.
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const iconsDir = path.join(projectRoot, 'public', 'icons')
const svgPath = path.join(iconsDir, 'currency-scan-icon.svg')

const NAVY = '#071B3C'
const MASKABLE_SCALE = 0.8

/** Read width/height from a PNG IHDR chunk (bytes 16..24). */
function pngSize(buffer) {
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('not a PNG file (bad signature)')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function makeHtml(svgMarkup, size, scale) {
  const artwork = Math.round(size * scale)
  return `<!doctype html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; background: ${NAVY}; }
  .stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .stage svg { width: ${artwork}px; height: ${artwork}px; display: block; }
</style>
</head>
<body><div class="stage">${svgMarkup}</div></body>
</html>`
}

const targets = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-512-maskable.png', size: 512, scale: MASKABLE_SCALE },
]

async function main() {
  await mkdir(iconsDir, { recursive: true })

  const svgMarkup = await readFile(svgPath, 'utf8')
  if (!svgMarkup.includes('viewBox="0 0 1024 1024"')) {
    throw new Error(`unexpected SVG master (missing 1024 viewBox): ${svgPath}`)
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    for (const target of targets) {
      await page.setViewportSize({ width: target.size, height: target.size })
      await page.setContent(makeHtml(svgMarkup, target.size, target.scale), {
        waitUntil: 'load',
      })
      await page.screenshot({ path: path.join(iconsDir, target.file) })
    }
  } finally {
    await browser.close()
  }

  for (const target of targets) {
    const outPath = path.join(iconsDir, target.file)
    const info = await stat(outPath)
    if (info.size === 0) throw new Error(`empty icon written: ${outPath}`)
    const { width, height } = pngSize(await readFile(outPath))
    if (width !== target.size || height !== target.size) {
      throw new Error(
        `icon ${target.file} is ${width}x${height}, expected ${target.size}x${target.size}`,
      )
    }
    console.log(`${target.file}: ${width}x${height}, ${info.size} bytes`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
