# JPEG ledger

Decisions for the JPEG codec. Update this file when behavior or scope changes.
Date of this snapshot: 2026-08-27 (supersedes 2026-08-16).

## Product

Pixels in, bytes out. Same `PixelBuffer` as PNG (packed 8-bit RGBA).

- `encodeJpeg(image, options?)` → baseline SOF0 or progressive SOF2 bytes
- `decodeJpeg(bytes, options?)` → RGBA (`alpha = 255`), upright

Decode is paired because codecs pair: roundtrips, Workers, and “shrink this JPEG” without a host decoder.

## Encode

| Option        | Default           | Why                                                                                                    |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `quality`     | `"balanced"`      | `"small"` = q65 4:2:0, `"balanced"` = q80 4:2:0, `"high"` = q90 4:4:4. A number is the IJG 1–100 scale |
| `chroma`      | from preset       | `"4:2:0"` / `"4:2:2"` (H=2,V=1) / `"4:4:4"`; overrides the preset                                      |
| `progressive` | `false`           | SOF2 with libjpeg-turbo’s 10-scan YCbCr script; always per-scan optimized tables                       |
| `background`  | `[255, 255, 255]` | JPEG has no alpha; compositing is a visible product decision, so it is a parameter                     |

Presets, not knobs: three named points cover what people actually pick (thumbnails, uploads, print-ish). The number survives because “q80” is a cross-tool convention (IJG, mozjpeg, browsers, Pillow), not because the scale is meaningful in itself. `"balanced"` = q80 matches the reference consumer’s `initialQuality: 0.8`; the old default of 75 is gone.

Optimized Huffman tables (T.81 K.2, libjpeg `jpeg_gen_optimal_table`) are always on — there is no `optimize` option. They are standard-compliant, 5–10% smaller, and the frequency count happens while the coefficients are stored, so the one-pass Annex-K path had no reason to exist and was deleted. The Annex K tables remain in `tables.ts` for the decoder.

Why progressive is _not_ the default: it costs a decoder-side coefficient buffer (2 bytes/sample) on every consumer, and the default browsers-and-CDNs expectation is still baseline. It is one flag away.

### Pipeline

```
RGBA → per-MCU: composite(background) → YCbCr → subsample → level shift → float FDCT → quantize (Int16, zigzag)
  baseline    → Int16 coefficient store (stats gathered while storing) → DHT → entropy-code
  progressive → Int16 coefficient store → per scan: gather → DHT → SOS
```

No full-image float planes. Peak extra memory ≈ 2 bytes per sample (the coefficient store) plus MCU scratch. The earlier `Float64Array` Y/Cb/Cr planes (~24 bytes/pixel; +359 MB on a 12 MP photo) were the reason the “Cloudflare Workers” claim did not hold.

DCT: float separable (T.81 A.3.3). Encode/decode invert exactly; integer AAN/LLM can wait. MCU pad = repeat edge. Chroma downsample = box filter.

Bit IO is MSB-first with 0xFF stuffing — do not reuse deflate’s LSB writer.

## Decode

| Option        | Default   | Why                                                                                                                                                                      |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxPixels`   | 50 MP     | Image pixels (width × height), checked right after SOF before any allocation; coefficient buffers are allocated at the first SOS (`src/limits.ts`, `src/jpeg/budget.ts`) |
| `orientation` | `"apply"` | EXIF 0x0112 applied so pixels are upright, like browsers’ `image-orientation: from-image`                                                                                |
| `upsample`    | `"fancy"` | libjpeg triangle filter for h2v1/h2v2; `"nearest"` replicates                                                                                                            |

Decoder exposes `decodeJpegCoefficients` (internal) for the transcoder. Supported: baseline SOF0 and progressive SOF2 (DC/AC first + refinement, EOBRUN, successive approximation), any H/V in 1–4, 1 and 3 components, 4 components via Adobe APP14 (transform 0 → inverted CMYK, 2 → YCCK, none → CMYK), restart intervals (DRI/RSTn: byte-align, consume the marker, reset DC predictors and EOBRUN; out-of-order markers tolerated).

Not supported (clean `Error`, never silent corruption): arithmetic coding, lossless, hierarchical, 12-bit.

Non-interleaved scans iterate `ceil(compW/8) × ceil(compH/8)`, not the MCU grid. This is the classic progressive bug and the tests pin it at odd sizes.

### Memory

Baseline decodes block by block into `Uint8Array` component planes at the component’s own resolution. Progressive keeps `Int16` coefficients (2 bytes/sample) until the last scan, then one dequantize + IDCT pass. Color conversion and upsampling stream from the component planes into the RGBA output row by row. The IDCT works on a 64-sample scratch.

### Orientation vs. metadata

The decoder otherwise ignores EXIF and ICC (pixels come out in the file’s color space; the product verbs carry the ICC profile to their output, see `ledger-image.md`). Orientation is different from the rest of the metadata: ignoring it yields _visibly wrong pixels_, and a decode → re-encode cycle bakes the wrong rotation in permanently. So orientation is applied by default and everything else is out of scope. Pass `orientation: "ignore"` to get the stored raster.

### Verification

`tests/jpeg_decode_test.ts` embeds libjpeg-turbo fixtures (37×29: baseline with restart, progressive 4:2:0 / 4:2:2 / gray, EXIF orientation 6) and compares to `djpeg` output. Restart and progressive match `djpeg -nosmooth` at MAE ≈ 0.03 (max 2–3); `upsample: "fancy"` is compared to default `djpeg`.

## Transcode (lossless)

`transcodeJpeg(bytes, { progressive? })` re-entropy-codes the quantized coefficients: same pixels, optimized Huffman tables, optional progressive, restart intervals dropped, metadata stripped (orientation ≠ 1 re-emitted as a one-tag EXIF so the file still displays upright; `metadata` passthrough is an option on top). This is `jpegtran -optimize [-progressive] -copy none`, and it lands **byte-for-byte on jpegtran's sizes** for every fixture (653 / 896 / 396 / 757 / 751 B…) with `djpeg` output byte-identical to the source.

Why it exists: `optimizeImage` must never re-quantize. A decode→encode at any quality is a second quantization and a q80 re-encode of a q92 source visibly degrades. Every trusted "optimize my JPEG" tool is coefficient-level for that reason.

How it shares code: there is **one** marker parser — `decodeJpegCoefficients` stops at zigzag `Int16` coefficients for both baseline and progressive input, and `decodeJpeg` is that plus IDCT + color. The writer (`scan.ts` / `markers.ts`) is the encoder's, generalized to 1/3/4 components, arbitrary sampling, and the source's DQT (16-bit tables included). Huffman selectors are remapped to luma = 0 / chroma = 1 (baseline allows two of each; nothing is lost).

## Not doing

- Arithmetic / lossless / hierarchical / 12-bit
- Grayscale _encode_ (3-component only; gray decodes fine)
- Custom scan scripts / trellis quantization (mozjpeg territory)
- Streaming / incremental decode (see README “Scope”)

## Scans and truncation

- At most **100 scans** per image (`JPEG: more than 100 scans`). Every scan walks the block grid, so the scan count is a CPU multiplier worth ~10 bytes each to an attacker: 3000 empty DC-refinement scans on a 4096² frame (62 KB) took 29 s in `shrinkImage`. 100 is what libjpeg-turbo’s fuzz harness sets via `TJPARAM_SCANLIMIT`; real progressive files have ~10.
- When a scan’s entropy data runs into a marker, the missing bits read as zeros and the rest of the scan (or of the restart interval, when an RSTn follows) is skipped — libjpeg’s `insufficient_data`. Blocks keep what earlier scans stored, so a cut-short file closed with EOI shows the decoded part and gray below it, like browsers. (The old reader fed 1-bits forever, which cost a full pass per empty scan and often ended in “invalid Huffman code”.) A file that simply ends mid-scan with no marker still throws `truncated entropy stream`, as before.

## Review round (2026-10)

- `maxPixels` counted every component sample (and the MCU padding), so 48–50 MP 4:2:0 phone photos and 24 MP 4:4:4 files failed the 50 MP default. It is width × height now, like PNG and GIF. The sample store needs no second budget: each plane is at most the MCU-padded grid, so it is ≤ 4 components × (w + 31) × (h + 31).
- Scan cap and early stop above.

## Review round (2026-08)

- **No JFIF on Adobe-RGB.** `transcodeJpeg` wrote a JFIF APP0 onto every 3-component file. For `cjpeg -rgb` output (Adobe APP14 transform 0, no JFIF) that told every decoder to treat RGB coefficients as YCbCr — `optimizeImage` shipped a smaller file with wrong colors. Now JFIF is written only for YCbCr (no Adobe, or transform 1), like `jpegtran`.
- Memory budget: SOF is parsed without allocating; coefficient stores are allocated at the first SOS. (This round also counted the padded grid and summed planes against `maxPixels`; the 2026-10 round reverted that to width × height.)
- ICC APP2 chunks are reassembled by sequence number; inconsistent sets are dropped rather than concatenated in file order.
- SOF3 / SOF1 / hierarchical / arithmetic / 12-bit throw messages that name the variant. All errors are `JPEG: …`; options are validated before any work.
