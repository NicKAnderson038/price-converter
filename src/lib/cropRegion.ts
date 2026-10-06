/**
 * Pure geometry for the camera-OCR crop guide (T19).
 *
 * The on-screen guide is drawn over a `<video>` that the browser renders with
 * `object-fit: cover` (or `contain`) into its layout box. This helper maps the
 * guide's viewport rectangle back to the *source video* pixel rectangle using
 * the exact math the browser uses to lay the video out, so OCR sees the region
 * the user is actually pointing at (WYSIWYG) instead of a fixed centre crop of
 * the raw frame.
 *
 * Keeping this free of DOM APIs makes it unit-testable in isolation.
 */

export type Rect = { x: number; y: number; width: number; height: number }
export type Region = { x: number; y: number; width: number; height: number }

const MIN_SIZE = 1

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  if (max < min) return max
  return Math.min(max, Math.max(min, value))
}

/**
 * Coerce a candidate dimension to a finite, drawImage-safe pixel count.
 *
 * Non-finite (`NaN`, `±Infinity`) and non-positive values (0, negatives) — the
 * ones that would otherwise round to `Infinity`/`NaN` — collapse to `MIN_SIZE`.
 */
function safeDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_SIZE
  return Math.max(MIN_SIZE, Math.round(value))
}

/** Coerce a coordinate/extent to a finite value, falling back when non-finite. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Map `guide` (viewport coords, e.g. `getBoundingClientRect()`) to a source
 * video pixel region.
 *
 * Layout assumed (matching CSS `object-fit`):
 *   - `scale = cover ? max(videoRect.w / videoWidth, videoRect.h / videoHeight)
 *                    : min(...)`
 *   - the video is scaled to `videoWidth * scale × videoHeight * scale` and
 *     centred inside `videoRect`;
 *   - the guide's offset from the video element's top-left, less the centring
 *     offset, divided by `scale`, is the source rectangle.
 *
 * Invalid/non-finite sizes (NaN, ±Infinity, 0, negative) fall back to a finite,
 * drawImage-safe region: dimensions are at least 1px, every coordinate is
 * finite, and the final clamped region is guaranteed finite so a caller can
 * always pass the result to `drawImage` safely.
 */
export function computeCropRegion(
  guide: Rect,
  videoRect: Rect,
  videoWidth: number,
  videoHeight: number,
  fit: 'cover' | 'contain' = 'cover',
): Region {
  const validVideo =
    Number.isFinite(videoWidth) &&
    videoWidth > 0 &&
    Number.isFinite(videoHeight) &&
    videoHeight > 0
  const validRect =
    Number.isFinite(videoRect.width) &&
    videoRect.width > 0 &&
    Number.isFinite(videoRect.height) &&
    videoRect.height > 0

  if (!validVideo || !validRect) {
    return {
      x: 0,
      y: 0,
      width: safeDimension(videoWidth),
      height: safeDimension(videoHeight),
    }
  }

  const scaleX = videoRect.width / videoWidth
  const scaleY = videoRect.height / videoHeight
  const scale = fit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY)
  if (!Number.isFinite(scale) || scale <= 0) {
    return {
      x: 0,
      y: 0,
      width: safeDimension(videoWidth),
      height: safeDimension(videoHeight),
    }
  }

  const displayedWidth = videoWidth * scale
  const displayedHeight = videoHeight * scale
  const offsetX = (videoRect.width - displayedWidth) / 2
  const offsetY = (videoRect.height - displayedHeight) / 2

  const rawX = (guide.x - videoRect.x - offsetX) / scale
  const rawY = (guide.y - videoRect.y - offsetY) / scale
  const rawWidth = guide.width / scale
  const rawHeight = guide.height / scale

  const x = finiteOr(clamp(rawX, 0, videoWidth - MIN_SIZE), 0)
  const y = finiteOr(clamp(rawY, 0, videoHeight - MIN_SIZE), 0)
  const width = clamp(finiteOr(rawWidth, MIN_SIZE), MIN_SIZE, videoWidth - x)
  const height = clamp(finiteOr(rawHeight, MIN_SIZE), MIN_SIZE, videoHeight - y)

  return { x, y, width, height }
}
