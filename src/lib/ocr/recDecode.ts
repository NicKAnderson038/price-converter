/**
 * Greedy CTC decoding for the PP-OCRv3 recognition head (Stage 3).
 *
 * The model output `softmax_5.tmp_0` is already softmaxed, so every value is a
 * class probability. Its shape is `[1, T, C]` with `T = 40` timesteps and
 * `C = 6625` classes; class 0 is the CTC blank and class `i > 0` maps to
 * `dict[i - 1]` (the PP-OCR dictionary offset).
 */

export type CtcResult = {
  /** Decoded glyphs with blanks and consecutive repeats collapsed. */
  text: string
  /** Mean max-probability over the emitted characters; 0 when nothing is kept. */
  score: number
  /** Per-character max probability, aligned index-for-index with `text`. */
  charScores: number[]
}

/**
 * Greedy (best-path) CTC decode over a `[1, T, C]` probability tensor.
 *
 * For each timestep the argmax class is taken; blank (0) timesteps are dropped
 * and consecutive repeated classes are collapsed (a repeat separated by a blank
 * is kept, as CTC requires). Surviving classes are mapped through `dict` using
 * the PP-OCR offset of one. `score` is the mean of the kept timesteps' max
 * probabilities.
 *
 * @throws when `shape[0]` is not 1: only a single sequence is decoded, so a
 *   batch of >1 would otherwise be silently truncated to batch 0.
 * @throws when `logits.length` does not equal `shape[0] * shape[1] * shape[2]`.
 */
export function greedyCtcDecode(
  logits: Float32Array,
  shape: readonly number[],
  dict: readonly string[],
): CtcResult {
  const [batch, timesteps, classes] = shape
  if (batch !== 1) {
    throw new Error(
      `CTC decode expects a batch size of 1, received ${batch} (shape ${shape.join('x')})`,
    )
  }
  const expected = batch * timesteps * classes
  if (logits.length !== expected) {
    throw new Error(
      `CTC logits length ${logits.length} does not match shape ${batch}x${timesteps}x${classes} (${expected})`,
    )
  }

  let text = ''
  const charScores: number[] = []
  let previous = -1

  for (let t = 0; t < timesteps; t += 1) {
    const base = t * classes
    let best = 0
    let bestProbability = logits[base]
    for (let c = 1; c < classes; c += 1) {
      const probability = logits[base + c]
      if (probability > bestProbability) {
        bestProbability = probability
        best = c
      }
    }

    // Drop the CTC blank and collapse consecutive repeats. Recording `best`
    // (including blank) as `previous` keeps repeats separated by a blank.
    if (best !== 0 && best !== previous) {
      const character = dict[best - 1]
      if (character !== undefined) {
        text += character
        charScores.push(bestProbability)
      }
    }
    previous = best
  }

  const score =
    charScores.length > 0
      ? charScores.reduce((sum, value) => sum + value, 0) / charScores.length
      : 0

  return { text, score, charScores }
}
