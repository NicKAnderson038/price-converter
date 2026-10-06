import { test, expect } from '@playwright/test'
import { computeCropRegion } from '../src/lib/cropRegion.ts'
import type { Region } from '../src/lib/cropRegion.ts'

/**
 * Deterministic, pure-function guard for the Stage-1 (T19) scanner crop fix.
 *
 * These run without a camera, OCR worker, or browser page, so they are the
 * reliable regression guard: the on-screen guide must map to the *source video*
 * region the user is actually pointing at (WYSIWYG), not the old fixed centre
 * crop of the raw frame. Tolerances allow only floating-point rounding.
 */

const VIDEO_WIDTH = 1920
const VIDEO_HEIGHT = 1080

function expectFiniteRegion(region: Region): void {
  for (const value of [region.x, region.y, region.width, region.height]) {
    expect(Number.isFinite(value)).toBe(true)
  }
  expect(region.width).toBeGreaterThanOrEqual(1)
  expect(region.height).toBeGreaterThanOrEqual(1)
}

test.describe('computeCropRegion WYSIWYG mapping', () => {
  // Concrete vector from the panel geometry: a 300x400 video box with the
  // guide band at 10% left / 33% top, 80% wide / 34% tall.
  const videoRect = { x: 0, y: 0, width: 300, height: 400 }
  const guide = { x: 30, y: 132, width: 240, height: 136 }

  test('cover: maps the guide to the covered source region (the T19 bug scenario)', () => {
    const region = computeCropRegion(guide, videoRect, VIDEO_WIDTH, VIDEO_HEIGHT, 'cover')

    // scale = max(300/1920, 400/1080) = 0.370370...
    expect(region.x).toBeCloseTo(636, 3)
    expect(region.y).toBeCloseTo(356.4, 3)
    expect(region.width).toBeCloseTo(648, 3)
    expect(region.height).toBeCloseTo(367.2, 3)

    // The region centre tracks the source centre because the guide is centred.
    expect(region.x + region.width / 2).toBeCloseTo(VIDEO_WIDTH / 2, 3)
    expect(region.y + region.height / 2).toBeCloseTo(VIDEO_HEIGHT / 2, 3)
    expectFiniteRegion(region)
  })

  test('cover: the mapped region differs from the old raw 60%x60% centre crop', () => {
    const region = computeCropRegion(guide, videoRect, VIDEO_WIDTH, VIDEO_HEIGHT, 'cover')
    const oldCentreCrop = { x: 384, y: 216, width: 1152, height: 648 }

    // Removing the T19 fix would reproduce the old fixed crop exactly.
    expect(region).not.toEqual(oldCentreCrop)
    expect(region.width).toBeLessThan(oldCentreCrop.width)
    expect(region.height).toBeLessThan(oldCentreCrop.height)
    expect(Math.abs(region.x - oldCentreCrop.x)).toBeGreaterThan(1)
  })

  test('contain: letterboxes the frame and maps within [0, videoWidth/Height]', () => {
    const region = computeCropRegion(guide, videoRect, VIDEO_WIDTH, VIDEO_HEIGHT, 'contain')

    // scale = min(300/1920, 400/1080) = 0.15625; the video is centred with a
    // vertical letterbox, so the guide starts near the top of the source.
    expect(region.x).toBeCloseTo(192, 3)
    expect(region.y).toBeCloseTo(104.8, 3)
    expect(region.width).toBeCloseTo(1536, 3)
    expect(region.height).toBeCloseTo(870.4, 3)

    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.width).toBeLessThanOrEqual(VIDEO_WIDTH)
    expect(region.y + region.height).toBeLessThanOrEqual(VIDEO_HEIGHT)
    expectFiniteRegion(region)
  })

  test('clamps a guide partly outside the video box into the frame', () => {
    const partlyOutside = { x: -50, y: -50, width: 240, height: 136 }
    const region = computeCropRegion(
      partlyOutside,
      videoRect,
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      'cover',
    )

    // y is driven above the top edge → clamped to 0; the rest stays in frame.
    expect(region.x).toBeCloseTo(420, 3)
    expect(region.y).toBe(0)
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.width).toBeLessThanOrEqual(VIDEO_WIDTH)
    expect(region.y + region.height).toBeLessThanOrEqual(VIDEO_HEIGHT)
    expectFiniteRegion(region)
  })

  test('clamps a guide fully outside the video box to a >=1px in-frame region', () => {
    const fullyOutside = { x: 5000, y: 5000, width: 240, height: 136 }
    const region = computeCropRegion(fullyOutside, videoRect, VIDEO_WIDTH, VIDEO_HEIGHT, 'cover')

    // Both axes pin to the last in-frame pixel and keep MIN_SIZE.
    expect(region.x).toBeLessThanOrEqual(VIDEO_WIDTH - 1)
    expect(region.y).toBeLessThanOrEqual(VIDEO_HEIGHT - 1)
    expect(region.width).toBeGreaterThanOrEqual(1)
    expect(region.height).toBeGreaterThanOrEqual(1)
    expect(region.x + region.width).toBeLessThanOrEqual(VIDEO_WIDTH)
    expect(region.y + region.height).toBeLessThanOrEqual(VIDEO_HEIGHT)
    expectFiniteRegion(region)
  })

  test('handles a non-zero videoRect origin with rect-relative math', () => {
    const offsetVideoRect = { x: 40, y: 50, width: 300, height: 400 }
    // Same guide shifted by the rect origin must yield the same source region.
    const shiftedGuide = { x: 30 + 40, y: 132 + 50, width: 240, height: 136 }
    const region = computeCropRegion(
      shiftedGuide,
      offsetVideoRect,
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
      'cover',
    )

    expect(region.x).toBeCloseTo(636, 3)
    expect(region.y).toBeCloseTo(356.4, 3)
    expect(region.width).toBeCloseTo(648, 3)
    expect(region.height).toBeCloseTo(367.2, 3)
    expectFiniteRegion(region)
  })

  test('zero or negative video dimensions return a safe >=1px region (no NaN/Infinity)', () => {
    const zero = computeCropRegion(guide, videoRect, 0, 0, 'cover')
    expectFiniteRegion(zero)

    const negative = computeCropRegion(guide, videoRect, -1920, -1080, 'cover')
    expectFiniteRegion(negative)

    const nullable = computeCropRegion(guide, videoRect, Number.NaN, VIDEO_HEIGHT, 'cover')
    expectFiniteRegion(nullable)

    const negativeInfinity = computeCropRegion(
      guide,
      videoRect,
      VIDEO_WIDTH,
      Number.NEGATIVE_INFINITY,
      'cover',
    )
    expectFiniteRegion(negativeInfinity)
  })

  // Regression guard (T21): a *positive* non-finite video dimension used to
  // escape the "invalid sizes fall back safely" contract in
  // src/lib/cropRegion.ts — `Math.round(Infinity)` made the fallback return an
  // infinite width or height, which is neither finite nor drawImage-safe. Both
  // dimensions must now collapse to a finite, >=1px region.
  test('positive non-finite video dimensions return a finite >=1px region', () => {
    const infiniteHeight = computeCropRegion(
      guide,
      videoRect,
      VIDEO_WIDTH,
      Number.POSITIVE_INFINITY,
      'cover',
    )
    expectFiniteRegion(infiniteHeight)

    const infiniteWidth = computeCropRegion(
      guide,
      videoRect,
      Number.POSITIVE_INFINITY,
      VIDEO_HEIGHT,
      'cover',
    )
    expectFiniteRegion(infiniteWidth)
  })

  test('degenerate videoRect returns a safe >=1px region', () => {
    const zeroRect = computeCropRegion(guide, { x: 0, y: 0, width: 0, height: 0 }, VIDEO_WIDTH, VIDEO_HEIGHT)
    expectFiniteRegion(zeroRect)

    const negativeRect = computeCropRegion(
      guide,
      { x: 0, y: 0, width: -300, height: -400 },
      VIDEO_WIDTH,
      VIDEO_HEIGHT,
    )
    expectFiniteRegion(negativeRect)
  })
})
