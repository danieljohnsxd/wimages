# Image ledger — `optimizeImage`, `shrinkImage`, `decodeImage`, `resize`

Decisions for the product-level entry points. Date of this snapshot: 2026-08-27.

## Why a product function exists at all

The codecs are “pixels in, bytes out.” A typical upload path does not want a codec; it wants _“this upload, ≤ 2048 px, ≤ 1 MiB, upright, JPEG or PNG”_ — commonly assembled from `browser-image-compression` in a Web Worker plus a server-side re-compress fallback. That is one operation with four decisions inside it (format, size, quality, keep-or-replace). Making every caller re-derive those decisions from `resize` + `encodeJpeg` + a quality loop is how you get five slightly different pipelines. So the library ships the operation.

Two verbs, and the split is **lossless vs lossy** — that is the distinction users actually reason about, ahead of any effort or quality lever:

| Verb                                        | Pixels                        | Bytes                | Metadata                                                    |
| ------------------------------------------- | ----------------------------- | -------------------- | ----------------------------------------------------------- |
| `optimizeImage(bytes)`                      | identical                     | smaller or unchanged | EXIF/XMP stripped, ICC kept (orientation kept as a tag)     |
| `shrinkImage(bytes, { maxSide, maxBytes })` | resized/requantized as needed | ≤ `maxBytes`         | EXIF/XMP stripped, ICC kept (orientation baked into pixels) |

Everything under them is exported for people who need the parts. A flag (`lossless: true`) that silently changes what `maxSide` means was considered and rejected: a verb cannot be misread.

## `optimizeImage` (lossless)

- PNG: decode → `encodePng({ effort: "strong" })`. Smallest exact color type, adaptive filters, level-9 deflate. 16-bit PNGs keep their bytes (re-encoding to 8-bit would not be lossless); only metadata chunks can go.
- JPEG: `transcodeJpeg` — re-entropy-codes the existing quantized coefficients with optimal Huffman tables (and optionally progressive). No decode to pixels, no generation loss. This is `jpegtran -optimize`. Restart intervals are dropped.
- GIF: `optimizeGif` — gifsicle-style frame re-planning (see `ledger-gif.md`). Re-LZW alone gains nothing; the frame planner is where the bytes are.
- APNG: `decodeApng` → `encodeApng({ effort: "strong" })`, same planner.
- If the result is not smaller, the caller’s bytes come back — but with `keepMetadata: false` never with their EXIF / XMP / text: those segments are cut out in place (JPEG APP1/APP3–15/COM/non-ICC APP2 and data after EOI; PNG `eXIf`/`tEXt`/`zTXt`/`iTXt`/`tIME`; GIF comment and non-NETSCAPE/ICC application extensions), entropy data copied as-is, and `changed: true`. `changed: false` now means the input had nothing to strip. (2026-10 review: the old “metadata and all” fallback returned a progressive JPEG’s GPS EXIF whenever the baseline transcode was larger — i.e. for most already-optimized phone photos.)

Why the JPEG path is coefficient-level: a decode→encode round trip at any quality quantizes twice, and a q80 re-encode of a q92 source visibly degrades. Most “optimize my JPEG” tools that people trust (jpegtran, ImageOptim, mozjpeg’s `-copy none`) are coefficient-level for that reason.

## `shrinkImage` (lossy)

| Option     | Default      | Why                                                                                                             |
| ---------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `maxSide`  | 2048         | A sane display ceiling for uploads (every photo product has a long-side knob like this)                         |
| `maxBytes` | 1 MiB        | A hard ceiling, not a target                                                                                    |
| `format`   | `"auto"`     | PNG with alpha or ≤ 256 colors stays PNG (graphics, screenshots); JPEG stays JPEG; everything else becomes JPEG |
| `quality`  | `"balanced"` | q80 4:2:0 — the JPEG starting point                                                                             |

Output bytes are **always ours** — never the caller’s original — so the result is always metadata-free and safe to store. `lossless: true` means the pixels are identical to the input (it took the lossless rewrite path); it is deliberately not called `changed`, which on `optimizeImage` means “the bytes are not yours”, a different question.

### Already fits → lossless

If the decoded image already satisfies `maxSide` and the output format equals the input format, `shrinkImage` takes the lossless path (`transcodeJpeg` / strong PNG re-encode) and only falls through to the lossy ladder when that still exceeds `maxBytes`. This replaced an earlier `keepInput` option that returned the original bytes: it was really a metadata decision hiding inside a byte-size optimization, and it let GPS EXIF leak through the “compressed” upload.

### Fitting `maxBytes`

Deterministic ladder, bounded work, no binary search on a noisy function:

1. Decode (orientation applied), pick format, resize to `maxSide` (Lanczos3).
2. JPEG: encode at the starting quality; while over, step down the ladder **80 → 72 → 65 → 58 → 50 → 42 → 35**. PNG: full color, then quantized to 256 colors; each is probed with a `"fast"` encode and gets the `"strong"` encode only when the probe × the strong/fast ratio (assumed 0.4, then measured on this image) can fit. The whole ladder is walked again at each ×0.8 downscale until the 256 px floor — there is no separate encode-count cap (an earlier `SHRINK_MAX_ENCODES = 10` silently aborted after one downscale; a reviewer caught it). For PNG, sizes whose bytes-∝-pixels estimate from the last attempt is still over budget are skipped (downscaled images only get denser, so the estimate never skips a size that would fit).
3. Still over: downscale the long side ×0.8 and restart the ladder. Stop with an `Error` once the long side would go below 256 px.

Quality below 35 is not worth serving; shrinking pixels beats shredding them.

Measured (2026-10): 2048² random RGBA → PNG went from 104 s (two `"strong"` encodes and a median cut at every one of ~5 sizes; the median cut recomputed every box's range each pass and remapped through a per-pixel map) to 11.5 s with the same output (704,303 bytes, 838²). The quantizer fixes are exact — byte-identical palettes and pixels.

### Metadata

`keepMetadata: false` (default) strips EXIF and XMP on both verbs and keeps the ICC profile; `true` carries EXIF/ICC/XMP through, across containers too. Two things survive stripping because dropping them produces visibly wrong pixels: orientation (the lossless path re-emits it as a one-tag EXIF that browsers honor, the lossy path bakes it into the raster) and ICC (Display P3 iPhone photos and macOS screenshots go dull when their profile is dropped without converting to sRGB, and the profile says nothing about the user — GPS, device and time live in EXIF). A boolean, not a string: there are two states and nothing to match on.

### What it is not

Not a thumbnail generator (call `resize` + `encodeJpeg`), not a HEIC converter (browsers hand us JPEG at a file input that accepts `image/jpeg`; server-side HEIC is out of scope — HEVC decode is not a pure-JS project).

## Levers that survived

| Lever                  | Kept? | Why                                                                        |
| ---------------------- | ----- | -------------------------------------------------------------------------- |
| PNG `effort`           | yes   | 5× time for 20–60% fewer bytes is a real boundary (zstd’s fast/strong)     |
| PNG `maxColors`        | yes   | the lossy opt-in for a lossless codec; a count, not a scale                |
| JPEG `quality` presets | yes   | a loss dial, not an effort dial; three named points + the interop q-number |
| JPEG effort            | no    | nothing to trade — optimal Huffman is always on                            |
| GIF `dither`           | yes   | on/off, and visible                                                        |

## `decodeImage`

Sniffs the container (PNG signature, `FF D8`, `GIF87a`/`GIF89a`) and dispatches. `sniffImageFormat` is exported for content-type validation without decoding. GIF → first frame. Unknown bytes throw.

## `resize`

Separable two-pass resampling; Lanczos3 with support scaled by the downscale ratio (so a 5× downscale does not alias), `"box"` as the cheap area-average alternative. Premultiplied alpha through the filter (no dark fringes on transparent edges), skipped entirely for opaque images. `Float32` intermediate of the intermediate size only. Never upscales unless asked. 4000×3000 → 2048×1536 in ~330 ms on Node 24.

Not doing: bicubic/bilinear variants (Lanczos3 downscale is the quality answer, box is the speed answer), rotation/crop (orientation is handled in decode).
