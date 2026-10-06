/**
 * Pure image preprocessing for the PP-OCRv3 recognition model (Stage 3).
 *
 * Mirrors PaddleOCR's recognition transform so the on-device browser path and
 * the reference implementation agree:
 *
 *   1. RGBA (canvas `ImageData` order) -> luminance grayscale.
 *   2. Min/max contrast stretch (no-op when the frame is already flat).
 *   3. Otsu threshold, used ONLY to find the ink bounding box — pixels are not
 *      binarised; the grayscale values are preserved.
 *   4. Optional crop to that ink box with >= 2px padding.
 *   5. Bilinear resize to height 48 preserving aspect, width capped at 320.
 *   6. Right-pad to 48x320 with 0 (the normalized padding PP-OCR uses).
 *   7. Replicate the grayscale across R, G and B, then normalise with
 *      `x / 127.5 - 1` (mean/std of 0.5) into an NCHW float32 tensor.
 *
 * This module is deliberately free of DOM and runtime-wasm imports so it can
 * run unchanged under Node for tests.
 */

/** Recognition input height in pixels (PP-OCRv3 uses 48). */
export const REC_HEIGHT = 48

/** Maximum recognition input width in pixels. */
export const REC_WIDTH = 320

/** NCHW input dimensions for the rec model: 1 batch, 3 channels, 48 x 320. */
export const REC_DIMS = [1, 3, REC_HEIGHT, REC_WIDTH] as const

/** RGBA image in canvas `ImageData` order (R, G, B, A per pixel). */
export type RawImage = {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Pixel padding added around the detected ink box before cropping (>= 2px). */
const INK_PADDING = 2

type Bounds = { x: number; y: number; width: number; height: number }

/**
 * Otsu's method: the threshold that maximises between-class variance for an
 * 8-bit grayscale histogram. Returns 127 for an empty input.
 */
export function computeOtsuThreshold(gray: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0)
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1
  const total = gray.length
  if (total === 0) return 127

  let sum = 0
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i]

  let sumBackground = 0
  let weightBackground = 0
  let maxVariance = 0
  let threshold = 127
  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t]
    if (weightBackground === 0) continue
    const weightForeground = total - weightBackground
    if (weightForeground === 0) break
    sumBackground += t * histogram[t]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const diff = meanBackground - meanForeground
    const variance = weightBackground * weightForeground * diff * diff
    if (variance > maxVariance) {
      maxVariance = variance
      threshold = t
    }
  }
  return threshold
}

/**
 * Bounding box of the ink pixels around an Otsu threshold.
 *
 * The threshold partitions pixels into a dark and a light class; whichever
 * class is the minority is treated as ink (text is usually the smaller share of
 * a cropped price frame). Returns `null` when the image is empty or entirely
 * one class.
 */
export function findInkBounds(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): Bounds | null {
  const pixels = width * height
  if (pixels <= 0 || gray.length < pixels) return null

  let dark = 0
  for (let i = 0; i < pixels; i += 1) {
    if (gray[i] <= threshold) dark += 1
  }
  const light = pixels - dark
  if (dark === 0 || light === 0) return null
  const inkIsDark = dark <= light

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const value = gray[row + x]
      const isInk = inkIsDark ? value <= threshold : value > threshold
      if (!isInk) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** RGBA -> luminance grayscale using rounded Rec. 601 weights. */
function toGrayscale(image: RawImage): Uint8Array {
  const pixels = image.width * image.height
  const gray = new Uint8Array(pixels)
  const { data } = image
  for (let p = 0, i = 0; p < pixels; p += 1, i += 4) {
    gray[p] = Math.round(
      data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114,
    )
  }
  return gray
}

/** Min/max contrast stretch to 0..255, in place; a flat frame is left as-is. */
function stretchContrast(gray: Uint8Array): void {
  let min = 255
  let max = 0
  for (let i = 0; i < gray.length; i += 1) {
    const value = gray[i]
    if (value < min) min = value
    if (value > max) max = value
  }
  const range = max - min
  if (range <= 0) return
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = Math.round(((gray[i] - min) * 255) / range)
  }
}

/**
 * Bilinear resample of a sub-rectangle of `source` to `targetWidth x
 * targetHeight`, returning grayscale values in 0..255.
 */
function resizeBilinear(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  crop: Bounds,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  const output = new Float32Array(targetWidth * targetHeight)
  const scaleX = crop.width / targetWidth
  const scaleY = crop.height / targetHeight

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const sampleY = Math.max(
      0,
      Math.min(sourceHeight - 1, crop.y + (ty + 0.5) * scaleY - 0.5),
    )
    const y0 = Math.floor(sampleY)
    const y1 = Math.min(sourceHeight - 1, y0 + 1)
    const wy = sampleY - y0

    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sampleX = Math.max(
        0,
        Math.min(sourceWidth - 1, crop.x + (tx + 0.5) * scaleX - 0.5),
      )
      const x0 = Math.floor(sampleX)
      const x1 = Math.min(sourceWidth - 1, x0 + 1)
      const wx = sampleX - x0

      const topLeft = source[y0 * sourceWidth + x0]
      const topRight = source[y0 * sourceWidth + x1]
      const bottomLeft = source[y1 * sourceWidth + x0]
      const bottomRight = source[y1 * sourceWidth + x1]
      const top = topLeft + (topRight - topLeft) * wx
      const bottom = bottomLeft + (bottomRight - bottomLeft) * wx
      output[ty * targetWidth + tx] = top + (bottom - top) * wy
    }
  }
  return output
}

/**
 * Build the `[1, 3, 48, 320]` float32 NCHW input tensor for the rec model.
 *
 * `trim` (default true) crops to the Otsu ink bounding box with >= 2px padding;
 * the threshold is never applied to the pixel values themselves. The crop is
 * resized to height 48 with the width preserving aspect and capped at 320 (when
 * capped, the crop is scaled to 320 wide, matching PaddleOCR). The normalized
 * crop is written into a zero-initialised tensor, so the right padding is 0 in
 * normalized space; the grayscale value is replicated across R, G and B, making
 * channel order irrelevant.
 *
 * Returns an all-zero tensor when `image` has no pixels.
 */
export function buildRecTensor(
  image: RawImage,
  opts?: { trim?: boolean },
): Float32Array {
  const tensor = new Float32Array(
    REC_DIMS[0] * REC_DIMS[1] * REC_DIMS[2] * REC_DIMS[3],
  )
  const { width, height, data } = image
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    return tensor
  }

  const gray = toGrayscale(image)
  stretchContrast(gray)

  let crop: Bounds = { x: 0, y: 0, width, height }
  if (opts?.trim ?? true) {
    const threshold = computeOtsuThreshold(gray)
    const bounds = findInkBounds(gray, width, height, threshold)
    if (bounds) {
      const x0 = Math.max(0, bounds.x - INK_PADDING)
      const y0 = Math.max(0, bounds.y - INK_PADDING)
      const x1 = Math.min(width, bounds.x + bounds.width + INK_PADDING)
      const y1 = Math.min(height, bounds.y + bounds.height + INK_PADDING)
      crop = {
        x: x0,
        y: y0,
        width: Math.max(1, x1 - x0),
        height: Math.max(1, y1 - y0),
      }
    }
  }

  const resizedWidth = Math.max(
    1,
    Math.min(REC_WIDTH, Math.round((REC_HEIGHT * crop.width) / crop.height)),
  )
  const resized = resizeBilinear(
    gray,
    width,
    height,
    crop,
    resizedWidth,
    REC_HEIGHT,
  )

  const plane = REC_HEIGHT * REC_WIDTH
  for (let y = 0; y < REC_HEIGHT; y += 1) {
    const sourceRow = y * resizedWidth
    const targetRow = y * REC_WIDTH
    for (let x = 0; x < resizedWidth; x += 1) {
      const normalized = resized[sourceRow + x] / 127.5 - 1
      const index = targetRow + x
      tensor[index] = normalized
      tensor[plane + index] = normalized
      tensor[2 * plane + index] = normalized
    }
  }

  return tensor
}
