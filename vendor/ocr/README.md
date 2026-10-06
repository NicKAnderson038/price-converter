# Vendored OCR assets

These files are committed to the repository (not fetched at build time) so that
`npm run assets:ocr` is fully offline and deterministic. The generated runtime
copies under `public/ocr/` are git-ignored and produced from these sources plus
`node_modules/onnxruntime-web`.

## Source

- Upstream distributor: [RapidAI/RapidOcrOnnx](https://github.com/RapidAI/RapidOcrOnnx),
  release tag `init`, asset `models.7z`:
  <https://github.com/RapidAI/RapidOcrOnnx/releases/download/init/models.7z>
- Original model: PaddleOCR PP-OCRv3
  ([PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)).
- License: Apache-2.0 — see [`LICENSE`](./LICENSE) for the full text and
  [`NOTICE`](./NOTICE) for the upstream attribution and per-file sha256.
- The archive also ships `ch_PP-OCRv3_det_infer.onnx` and
  `ch_ppocr_mobile_v2.0_cls_infer.onnx`; Stage 3 is rec-only and does not vendor
  those (detection/orientation are deferred).

## Files

| File | Bytes | sha256 |
| --- | ---: | --- |
| `ch_PP-OCRv3_rec_infer.onnx` | 10,690,752 | `897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615` |
| `ppocr_keys_v1.txt` | 26,249 | `28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7` |

### `ch_PP-OCRv3_rec_infer.onnx`

PP-OCRv3 Chinese recognition model. Input `[1,3,48,W]` float32; output
`softmax_5.tmp_0` shaped `[1,40,6625]` (T=40 max text length, C=6625 classes).

### `ppocr_keys_v1.txt`

UTF-8 character dictionary, one entry per line. The file has **6623 entries**
(26,249 bytes; `wc -l` reports 6622 because the final line has no trailing
newline).

The model's output has 6625 classes = 1 CTC blank + 6624 dictionary entries.
The decoder therefore **appends a single space at load time** so the dictionary
reaches 6624 entries (`dict[idx - 1]` for non-blank indices, index 0 = blank).
The file itself does not contain a single-space entry.
