import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  REC_DIMS,
  REC_HEIGHT,
  REC_WIDTH,
  buildRecTensor,
  computeOtsuThreshold,
  findInkBounds,
} from '../src/lib/ocr/preprocess.ts'
import type { RawImage } from '../src/lib/ocr/preprocess.ts'
import { greedyCtcDecode } from '../src/lib/ocr/recDecode.ts'
import { DICT_SIZE, parseDict } from '../src/lib/ocr/dict.ts'

/**
 * Deterministic, Node-side guard for the Stage-3 PP-OCRv3 math.
 *
 * These tests import the pure OCR modules (`preprocess`, `recDecode`, `dict`)
 * directly, so they need no browser, camera, wasm runtime or model file. They
 * pin the contracts the on-device engine depends on:
 *   - the `[1,3,48,320]` NCHW tensor shape and `x/127.5 - 1` normalisation,
 *   - Otsu-based ink trimming with >= 2px padding and zero right-padding,
 *   - greedy CTC decoding with blanks and repeat collapsing,
 *   - the 6624-entry dictionary (last entry is the appended space class).
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build an RGBA `RawImage` from a grayscale plane (R=G=B=gray, A=255). */
function rgbaFromGray(gray: ArrayLike<number>, width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p += 1) {
    const v = gray[p]
    data[p * 4] = v
    data[p * 4 + 1] = v
    data[p * 4 + 2] = v
    data[p * 4 + 3] = 255
  }
  return { data, width, height }
}

/** Uniform grayscale plane of `width * height` `value` bytes. */
function fillGray(width: number, height: number, value: number): Uint8Array {
  return new Uint8Array(width * height).fill(value)
}

/**
 * Width of the non-padding content in tensor `row` (index of the last non-zero
 * sample + 1). Right padding is written as 0 in normalised space and the
 * white/black test fixtures normalise to ±1, so a 0 sample is unambiguous pad.
 */
function contentWidth(tensor: Float32Array, row = 0): number {
  const base = row * REC_WIDTH
  for (let x = REC_WIDTH - 1; x >= 0; x -= 1) {
    if (tensor[base + x] !== 0) return x + 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// constants + tensor shape
// ---------------------------------------------------------------------------

test.describe('rec tensor contract', () => {
  test('REC_DIMS/REC_HEIGHT/REC_WIDTH match PP-OCRv3 (1x3x48x320)', () => {
    expect(REC_HEIGHT).toBe(48)
    expect(REC_WIDTH).toBe(320)
    expect([...REC_DIMS]).toEqual([1, 3, 48, 320])
  })

  test('buildRecTensor produces a 1*3*48*320 = 46080-length tensor', () => {
    const image = rgbaFromGray(fillGray(8, 8, 128), 8, 8)
    const tensor = buildRecTensor(image, { trim: false })
    expect(tensor).toBeInstanceOf(Float32Array)
    expect(tensor.length).toBe(1 * 3 * 48 * 320)
    expect(tensor.length).toBe(46080)
  })

  test('an empty image yields an all-zero 46080 tensor (no throw)', () => {
    const tensor = buildRecTensor({ data: new Uint8ClampedArray(0), width: 0, height: 0 })
    expect(tensor.length).toBe(46080)
    expect(tensor.every((value) => value === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

test.describe('normalisation', () => {
  test('every sample is inside [-1, 1] and the three channels are identical', () => {
    // A tiny 2x1 image (black, white) resized up; values interpolate between 0
    // and 255, so the normalised output must stay within the [-1, 1] range.
    const image = rgbaFromGray([0, 255], 2, 1)
    const tensor = buildRecTensor(image, { trim: false })

    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < tensor.length; i += 1) {
      if (tensor[i] < min) min = tensor[i]
      if (tensor[i] > max) max = tensor[i]
    }
    expect(min).toBeGreaterThanOrEqual(-1)
    expect(max).toBeLessThanOrEqual(1)
    expect(min).toBeCloseTo(-1, 6)
    expect(max).toBeCloseTo(1, 6)

    const plane = REC_HEIGHT * REC_WIDTH
    let channelsIdentical = true
    for (let i = 0; i < plane; i += 1) {
      if (tensor[plane + i] !== tensor[i] || tensor[2 * plane + i] !== tensor[i]) {
        channelsIdentical = false
        break
      }
    }
    expect(channelsIdentical).toBe(true)
  })

  test('black maps to -1 and white to +1', () => {
    const plane = REC_HEIGHT * REC_WIDTH
    const black = buildRecTensor(rgbaFromGray(fillGray(4, 4, 0), 4, 4), { trim: false })
    const white = buildRecTensor(rgbaFromGray(fillGray(4, 4, 255), 4, 4), { trim: false })
    expect(black[0]).toBeCloseTo(-1, 6)
    expect(black[plane]).toBeCloseTo(-1, 6)
    expect(white[0]).toBeCloseTo(1, 6)
    expect(white[plane]).toBeCloseTo(1, 6)
  })
})

// ---------------------------------------------------------------------------
// Otsu + ink bounds
// ---------------------------------------------------------------------------

test.describe('Otsu threshold + ink bounds', () => {
  test('computeOtsuThreshold returns 127 for an empty plane', () => {
    expect(computeOtsuThreshold(new Uint8Array(0))).toBe(127)
  })

  test('computeOtsuThreshold separates two grayscale classes', () => {
    const width = 20
    const height = 10
    const gray = fillGray(width, height, 10)
    // 100 pixels of 200, 100 pixels of 10 (bimodal).
    for (let i = 100; i < 200; i += 1) gray[i] = 200

    const threshold = computeOtsuThreshold(gray)
    expect(threshold).toBeGreaterThanOrEqual(10)
    expect(threshold).toBeLessThan(200)

    let dark = 0
    let light = 0
    for (let i = 0; i < gray.length; i += 1) {
      if (gray[i] <= threshold) dark += 1
      else light += 1
    }
    expect(dark).toBe(100)
    expect(light).toBe(100)
  })

  test('findInkBounds trims a dark minority region', () => {
    const width = 10
    const height = 10
    const gray = fillGray(width, height, 200)
    for (let y = 3; y <= 5; y += 1) {
      for (let x = 2; x <= 4; x += 1) gray[y * width + x] = 0
    }

    expect(findInkBounds(gray, width, height, 128)).toEqual({
      x: 2,
      y: 3,
      width: 3,
      height: 3,
    })
  })

  test('findInkBounds treats a light minority as ink (light-on-dark label)', () => {
    const width = 10
    const height = 10
    const gray = fillGray(width, height, 20)
    for (let y = 1; y <= 2; y += 1) {
      for (let x = 5; x <= 6; x += 1) gray[y * width + x] = 255
    }

    expect(findInkBounds(gray, width, height, 128)).toEqual({
      x: 5,
      y: 1,
      width: 2,
      height: 2,
    })
  })

  test('findInkBounds returns null for empty or single-class images', () => {
    expect(findInkBounds(new Uint8Array(0), 0, 0, 128)).toBeNull()
    // All pixels are one class regardless of threshold ordering.
    expect(findInkBounds(fillGray(8, 8, 200), 8, 8, 128)).toBeNull()
    expect(findInkBounds(fillGray(8, 8, 0), 8, 8, 128)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ink trim + zero padding in the built tensor
// ---------------------------------------------------------------------------

test.describe('ink trim + right padding', () => {
  // 100x100 white canvas with a 20x10 black block at (10, 20). Trimming adds 2px
  // of padding: crop = 24x14 -> resized width = round(48 * 24 / 14) = 82. Without
  // trimming the whole 100x100 frame resizes to 48 wide.
  const width = 100
  const height = 100
  const trimmedWidth = Math.min(REC_WIDTH, Math.round((REC_HEIGHT * 24) / 14))
  const untrimmedWidth = Math.min(REC_WIDTH, Math.round((REC_HEIGHT * width) / height))

  function blockImage(): RawImage {
    const gray = fillGray(width, height, 255)
    for (let y = 20; y < 30; y += 1) {
      for (let x = 10; x < 30; x += 1) gray[y * width + x] = 0
    }
    return rgbaFromGray(gray, width, height)
  }

  test('trimmed tensor is as wide as the padded ink box and zero-padded after', () => {
    const tensor = buildRecTensor(blockImage())
    expect(trimmedWidth).toBe(82)

    // Content reaches column 81; columns 82..319 are the normalised zero pad.
    expect(tensor[trimmedWidth - 1]).not.toBe(0)
    expect(tensor[trimmedWidth]).toBe(0)
    expect(tensor[100]).toBe(0)
    expect(tensor[REC_WIDTH - 1]).toBe(0)
    expect(contentWidth(tensor)).toBe(trimmedWidth)
  })

  test('trim:false uses the whole frame, so its content is narrower', () => {
    const untrimmed = buildRecTensor(blockImage(), { trim: false })
    expect(untrimmedWidth).toBe(48)

    expect(untrimmed[untrimmedWidth - 1]).not.toBe(0)
    expect(untrimmed[untrimmedWidth]).toBe(0)
    expect(contentWidth(untrimmed)).toBe(untrimmedWidth)

    // The crop really changed the content region, not just the padding.
    const trimmed = buildRecTensor(blockImage())
    expect(trimmed[60]).not.toBe(0)
    expect(untrimmed[60]).toBe(0)
    expect(contentWidth(trimmed)).toBeGreaterThan(contentWidth(untrimmed))
  })
})

// ---------------------------------------------------------------------------
// greedy CTC decode
// ---------------------------------------------------------------------------

test.describe('greedy CTC decode', () => {
  /** One-hot `[1, timesteps, classes]` logits with a chosen class per step. */
  function oneHot(steps: number[], classes: number): Float32Array {
    const logits = new Float32Array(steps.length * classes)
    for (let t = 0; t < steps.length; t += 1) logits[t * classes + steps[t]] = 1
    return logits
  }

  test('decodes a one-hot path spelling "12.50" (with repeats + blanks)', () => {
    const dict = ['1', '2', '.', '5', '0']
    const classes = dict.length + 1 // blank at class 0
    const classFor = (ch: string): number => dict.indexOf(ch) + 1
    // '1' then a repeated '1' (collapsed), blank, then 2 . 5, blank, 0.
    const steps = [
      classFor('1'),
      classFor('1'),
      0,
      classFor('2'),
      classFor('.'),
      classFor('5'),
      0,
      classFor('0'),
    ]
    const result = greedyCtcDecode(oneHot(steps, classes), [1, steps.length, classes], dict)

    expect(result.text).toBe('12.50')
    expect(result.charScores).toEqual([1, 1, 1, 1, 1])
    expect(result.score).toBeCloseTo(1, 6)
  })

  test('keeps a repeated glyph separated by a blank (CTC requirement)', () => {
    const dict = ['A']
    const classes = 2
    const result = greedyCtcDecode(oneHot([1, 0, 1], classes), [1, 3, classes], dict)
    expect(result.text).toBe('AA')
  })

  test('blank-only output decodes to an empty string with score 0', () => {
    const dict = ['A', 'B']
    const classes = dict.length + 1
    const result = greedyCtcDecode(oneHot([0, 0, 0, 0], classes), [1, 4, classes], dict)
    expect(result.text).toBe('')
    expect(result.charScores).toEqual([])
    expect(result.score).toBe(0)
  })

  test('throws when the logits length does not match the shape', () => {
    expect(() =>
      greedyCtcDecode(new Float32Array(5), [1, 2, 3], ['A', 'B']),
    ).toThrow(/does not match shape/)
  })

  test('throws when the batch size is not 1 (no silent batch-0 truncation)', () => {
    expect(() =>
      greedyCtcDecode(new Float32Array(6), [2, 1, 3], ['A', 'B']),
    ).toThrow(/batch size of 1/)
  })
})

// ---------------------------------------------------------------------------
// dictionary file
// ---------------------------------------------------------------------------

test.describe('ppocr dictionary', () => {
  test('vendor/ocr/ppocr_keys_v1.txt parses to 6624 entries ending in a space', () => {
    // Read the committed vendored dictionary, not the generated/git-ignored
    // `public/ocr/dict/` copy, so this math tier runs on a fresh checkout
    // without `npm run assets:ocr`.
    const dictPath = path.resolve(process.cwd(), 'vendor', 'ocr', 'ppocr_keys_v1.txt')
    const dict = parseDict(readFileSync(dictPath, 'utf8'))

    expect(DICT_SIZE).toBe(6624)
    expect(dict.length).toBe(6624)
    expect(dict[dict.length - 1]).toBe(' ')
  })

  test('parseDict rejects a wrong-sized dictionary', () => {
    expect(() => parseDict('a\nb\nc')).toThrow(/must contain 6624 entries/)
  })
})
