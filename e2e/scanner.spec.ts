import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const APP = '/price-converter/'
const APP_URL = `http://localhost:4173${APP}`

/** Camera stub: a canvas stream drawing high-contrast black-on-white text. */
function canvasStreamInit(text: string): void {
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  const ctx = canvas.getContext('2d')
  const draw = (): void => {
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 160px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
    requestAnimationFrame(draw)
  }
  draw()

  const stream = canvas.captureStream(30)
  const getUserMedia = (): Promise<MediaStream> => Promise.resolve(stream)
  const mediaDevices = navigator.mediaDevices
  if (mediaDevices) {
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: getUserMedia,
    })
  } else {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
  }
}

test.describe('scanner camera denial + manual entry', () => {
  test.beforeEach(async ({ page }) => {
    // Deterministically deny the camera; the fallback copy is what we assert.
    await page.addInitScript(() => {
      const denied = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      const mediaDevices = navigator.mediaDevices
      if (mediaDevices) {
        Object.defineProperty(mediaDevices, 'getUserMedia', {
          configurable: true,
          value: denied,
        })
      } else {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: denied },
        })
      }
    })
  })

  test('a denied camera shows a clear message and keeps manual entry usable', async ({ page }) => {
    await page.goto(APP)

    await page.getByTestId('scan-price').click()
    await expect(page.getByTestId('scanner-panel')).toBeVisible()

    await page.getByRole('button', { name: 'Start camera' }).click()

    // Scope to the scanner panel: the converter also renders a role="alert"
    // for its no-cache result error.
    const alert = page.getByTestId('scanner-panel').getByRole('alert')
    await expect(alert).toContainText('Enter the amount manually')
    await expect(alert).toContainText(/Camera permission was denied|does not expose camera access/)

    const manual = page.getByTestId('scanner-manual-input')
    await expect(manual).toBeVisible()
    await manual.fill('12.50')
    await page.getByTestId('scanner-manual-submit').click()

    // Confirmation flows back to the converter amount and closes the panel.
    await expect(page.getByTestId('scanner-panel')).toHaveCount(0)
    await expect(page.getByTestId('amount-input')).toHaveValue('12.5')
  })
})

test.describe('scanner runs the real PP-OCR engine on a controlled video source', () => {
  test.beforeEach(async ({ page }) => {
    // Abort the rates provider so recognition can never depend on live network.
    await page.route(/api\.frankfurter\.dev/, (route) =>
      route.abort('internetdisconnected'),
    )
    // Replace the camera with a canvas stream drawing a clear price. This is a
    // genuine MediaStream video track, so the scanner's start()/waitForMetadata
    // paths and the real on-device ONNX engine (dynamic ort-wasm import, model
    // and dictionary load, preprocessing, CTC decode) all run unmodified.
    await page.addInitScript(canvasStreamInit, '12.50')
  })

  // The cold path downloads/compiles the onnxruntime wasm and loads the ~10 MB
  // model, so this needs far more than the default timeout. The candidate is
  // surfaced only after the rolling voter sees the value twice, i.e. after
  // several full inference passes.
  test('a canvas video source yields a candidate parsing to 12.5', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto(APP)
    await page.getByTestId('scan-price').click()
    await expect(page.getByTestId('scanner-panel')).toBeVisible()

    await page.getByRole('button', { name: 'Start camera' }).click()

    const confirm = page.getByTestId('scanner-confirm')
    await expect(confirm).toBeEnabled({ timeout: 90_000 })
    // '12.50' is an unambiguous dot-decimal reading; the converter value is 12.5.
    await expect(page.getByTestId('scanner-candidate')).toHaveText('12.5')

    // Confirm the candidate flows through the explicit confirm action.
    await confirm.click()
    await expect(page.getByTestId('scanner-panel')).toHaveCount(0)
    await expect(page.getByTestId('amount-input')).toHaveValue('12.5')
  })
})

test.describe('price-label fixture', () => {
  test('the saved price-label image is a valid PNG', () => {
    // `npm run test:e2e` runs from the package root.
    const fixture = path.resolve(process.cwd(), 'e2e', 'fixtures', 'price-label.png')
    expect(existsSync(fixture)).toBe(true)
    const bytes = readFileSync(fixture)
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  test('the fixture drawn onto the camera stream yields the parsed price', async ({ page }) => {
    test.setTimeout(120_000)

    // Serve the real fixture from disk under a stable same-origin URL. The PNG
    // is loaded by the init script's canvas and drawn as the camera feed.
    const fixture = path.resolve(process.cwd(), 'e2e', 'fixtures', 'price-label.png')
    await page.route('**/price-label.png', (route) =>
      route.fulfill({ path: fixture, contentType: 'image/png' }),
    )
    // Keep the recognition path independent of the live rates provider.
    await page.route(/api\.frankfurter\.dev/, (route) =>
      route.abort('internetdisconnected'),
    )

    await page.addInitScript(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      const ctx = canvas.getContext('2d')

      const img = new Image()
      let loaded = false
      img.onload = () => {
        loaded = true
      }
      img.src = '/price-label.png'

      const draw = (): void => {
        if (!ctx) return
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        if (loaded && img.naturalWidth > 0) {
          // Keep the label comfortably inside the centred OCR crop guide.
          const width = canvas.width * 0.3
          const height = width * (img.naturalHeight / img.naturalWidth)
          ctx.drawImage(img, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
        }
        requestAnimationFrame(draw)
      }
      draw()

      const stream = canvas.captureStream(30)
      const getUserMedia = (): Promise<MediaStream> => Promise.resolve(stream)
      const mediaDevices = navigator.mediaDevices
      if (mediaDevices) {
        Object.defineProperty(mediaDevices, 'getUserMedia', {
          configurable: true,
          value: getUserMedia,
        })
      } else {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia },
        })
      }
    })

    await page.goto(APP)
    await page.getByTestId('scan-price').click()
    await expect(page.getByTestId('scanner-panel')).toBeVisible()

    await page.getByRole('button', { name: 'Start camera' }).click()

    const confirm = page.getByTestId('scanner-confirm')
    await expect(confirm).toBeEnabled({ timeout: 90_000 })
    // The fixture reads ¥1,200; parseAmount strips the currency marker and the
    // thousands grouping, so the candidate value is 1200.
    await expect(page.getByTestId('scanner-candidate')).toHaveText('1200')
  })
})

test.describe('service worker offline OCR', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service worker inspection/offline emulation is Chromium-only',
  )

  /**
   * Real service worker path: open the scanner online so the engine fetches
   * every `/ocr/**` asset through the CacheFirst runtime route, then reload
   * offline and prove the same recognition still runs from cache. The camera is
   * the deterministic canvas stub, and the provider request is aborted so the
   * conversion path cannot depend on the live rates API.
   */
  test('online scanner open caches /ocr/** so an offline reload still scans', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ serviceWorkers: 'allow', locale: 'en-US' })
    const page = await context.newPage()

    try {
      await page.addInitScript(canvasStreamInit, '12.50')
      await context.route(/api\.frankfurter\.dev/, (route) =>
        route.abort('internetdisconnected'),
      )

      await page.goto(APP_URL)
      await page.evaluate(() => navigator.serviceWorker.ready)
      await page.reload()
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)

      // Online: warm the engine (panel open) and run one full scan so the
      // model, dictionary, ort glue and wasm are all fetched through the SW.
      await page.getByTestId('scan-price').click()
      await page.getByRole('button', { name: 'Start camera' }).click()
      await expect(page.getByTestId('scanner-confirm')).toBeEnabled({ timeout: 90_000 })

      // The CacheFirst route really stored same-origin /ocr/** responses.
      const cached = await page.evaluate(async () => {
        const cache = await caches.open('ocr-assets')
        const requests = await cache.keys()
        return requests.map((request) => request.url)
      })
      expect(cached.some((url) => url.includes('/ocr/'))).toBe(true)

      // Offline reload: the shell, engine and model all come from cache.
      await context.setOffline(true)
      await page.reload()
      await page.getByTestId('scan-price').click()
      await page.getByRole('button', { name: 'Start camera' }).click()
      await expect(page.getByTestId('scanner-confirm')).toBeEnabled({ timeout: 90_000 })
      await expect(page.getByTestId('scanner-candidate')).toHaveText('12.5')
    } finally {
      await context.close()
    }
  })
})
