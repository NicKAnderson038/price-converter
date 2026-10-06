/**
 * Character dictionary for the PP-OCRv3 recognition model (Stage 3).
 *
 * PP-OCRv3 rec emits `softmax_5.tmp_0` with shape `[1, 40, 6625]`: 40 CTC
 * timesteps over 6625 classes. Class 0 is the CTC blank; the remaining 6624
 * classes address glyphs in this dictionary, i.e. `dict[classIndex - 1]`.
 *
 * The vendored `ppocr_keys_v1.txt` lists 6623 glyphs, one per line and without
 * a trailing newline. PaddleOCR appends a trailing space class, giving 6624
 * entries to match the 6625 model classes. `parseDict` reproduces exactly that
 * convention so the decode table lines up with the model output.
 */

/** Number of characters (model classes minus the CTC blank) the rec head emits. */
export const DICT_SIZE = 6624

/**
 * Parse a PP-OCR keys file into the ordered class table used by CTC decoding.
 *
 * Splits on `\n`, drops a single trailing empty element (tolerating a file that
 * ends with a newline), appends the trailing space class that PP-OCR adds, and
 * throws when the result is not exactly {@link DICT_SIZE} entries.
 */
export function parseDict(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  lines.push(' ')
  if (lines.length !== DICT_SIZE) {
    throw new Error(
      `PP-OCR dict must contain ${DICT_SIZE} entries, received ${lines.length}`,
    )
  }
  return lines
}
