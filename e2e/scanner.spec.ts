import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const APP = '/price-converter/'

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

test.describe('scanner reads a controlled video source', () => {
  test.beforeEach(async ({ page }) => {
    // Replace the camera with a canvas stream drawing a large, high-contrast
    // price so a candidate can form without a real device. `captureStream`
    // produces a genuine MediaStream video track, so the scanner's start() and
    // waitForMetadata() paths run unmodified.
    await page.addInitScript(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      const ctx = canvas.getContext('2d')
      const draw = (): void => {
        if (!ctx) return
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#000000'
        ctx.font = 'bold 200px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('12.50', canvas.width / 2, canvas.height / 2)
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
  })

  // No exact OCR string is asserted: recognition can vary slightly by host and
  // build. The contract under test is that a live (canvas) video source reaches
  // the OCR pipeline and a stable candidate is surfaced.
  test('a canvas video source yields a stable detected candidate', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(APP)
    await page.getByTestId('scan-price').click()
    await expect(page.getByTestId('scanner-panel')).toBeVisible()

    await page.getByRole('button', { name: 'Start camera' }).click()

    const confirm = page.getByTestId('scanner-confirm')
    await expect(confirm).toBeEnabled({ timeout: 45_000 })
    await expect(page.getByTestId('scanner-candidate')).not.toHaveText('—')
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

  // The app has no file-upload path and OCR output depends on host fonts and
  // tesseract assets, so a specific reading would be brittle in CI. Documented
  // fixme instead of asserting brittle OCR output.
  test.fixme('OCR reads the fixture price label', async ({ page }) => {
    await page.goto(APP)
    await page.getByTestId('scan-price').click()
    await expect(page.getByTestId('scanner-panel')).toBeVisible()
    await page.setInputFiles('input[type="file"]', 'e2e/fixtures/price-label.png')
    await expect(page.getByTestId('scanner-candidate')).toContainText('1200')
  })
})
