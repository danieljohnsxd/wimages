# Why wimages behaves the way it does

Background for the `image-uploads` skill. Sources are the repo's own decision ledgers (`ledger-image.md`, `ledger-apng.md`, `ledger-gif.md`, `ledger-jpeg.md`, `ledger-png.md`, `ledger-review.md`) and the sources they name.

## The product: uploads that round-trip the way users expect

The reference consumer wants "this upload, ≤ 2048 px, ≤ 1 MiB, upright, JPEG or PNG", in a Web Worker or a Convex action, without native dependencies. That is one operation with four decisions inside it (format, size, quality, keep-or-replace), so the library ships the operation (`shrinkImage`) instead of making each caller rebuild it from `resize` + `encodeJpeg` + a quality loop.

The expectations it encodes:

- Upright: EXIF orientation is applied (or kept as a tag on the lossless path). Ignoring it gives visibly wrong pixels, and a decode → re-encode bakes the wrong rotation in permanently.
- Same colors: the ICC profile is kept by default. Without color conversion to sRGB, dropping a Display P3 profile (iPhone photos, macOS screenshots) makes the image render duller.
- Still animated: an animated GIF stays an animated GIF (or becomes APNG on request), never a video and never a silent first frame. Fitting a byte budget reduces colors, then drops every other frame (delays summed so total duration is kept), then downscales.
- Private: EXIF (GPS, device, timestamps), XMP and text chunks are stripped unless `keepMetadata: true`. This holds even when `optimizeImage` cannot beat the input: the original is stripped in place rather than returned with its GPS.

## Two verbs, split by loss

| Verb            | Pixels                          | Bytes                |
| --------------- | ------------------------------- | -------------------- |
| `optimizeImage` | identical                       | smaller or unchanged |
| `shrinkImage`   | resized / requantized as needed | ≤ `maxBytes`         |

A `lossless: true` flag that silently changes what `maxSide` means was considered and rejected: a verb cannot be misread. `optimizeImage` on JPEG is coefficient-level (`jpegtran -optimize` equivalent; it lands byte-for-byte on jpegtran's sizes for the test fixtures). A decode → re-encode at any quality quantizes twice; a q80 re-encode of a q92 source visibly degrades, which is why trusted "optimize my JPEG" tools (jpegtran, ImageOptim, mozjpeg `-copy none`) work on coefficients. GIF and APNG are re-planned frame by frame the way `gifsicle -O2/-O3` does (dirty rectangles, merged duplicate frames): naive animation is 5–12× larger than needed.

## Format choices

`format: "auto"`: JPEG stays JPEG; PNG/GIF with alpha or ≤ 256 colors → PNG; a PNG/GIF with more colors becomes JPEG only if it looks photographic (fewer than 15% of pixels equal their left neighbor), so screenshots and UI stay PNG; animations keep their container.

### Why APNG for animated stickers (ledger-apng.md, 2026-08)

The question for an upload library is where animated stickers with alpha go, and there APNG is the native format:

- Discord animated stickers: APNG, 500 KB cap; GIF explicitly not wanted.
- iMessage sticker packs: APNG.
- Slack and Discord custom emoji: APNG accepted.
- Signal animated stickers: APNG.
- Browsers: ~96% (Chrome 59+, Firefox 3+, Safari 8+, Edge).

APNG also degrades gracefully: a non-APNG viewer shows the first frame instead of a broken image. Sources named in the ledger: Discord sticker guides (2026), Apple sticker pack docs, caniuse `apng`, ezgif "alternatives to animated GIF". GIF remains the meme / interchange animation format.

GIF has one transparent index, not 8-bit alpha: pixels with alpha < 128 become fully transparent, the rest opaque. That is why alpha animations should go to APNG.

### Why no WebP / AVIF / HEIC output

No shipped pure-JS encoder (WebP is a stated goal, not shipped, and not advertised). JPEG, PNG and GIF open everywhere an upload ends up. HEIC: browsers hand over JPEG at a file input that accepts `image/jpeg`; server-side HEIC is out of scope because HEVC decode is not a pure-JS project. Unsupported inputs throw an error that names the format.

## Defaults and presets, not levels

| Option         | Default                                          | Why                                                                                      |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `maxSide`      | 2048                                             | A sane display ceiling for uploads (the reference consumer's value)                      |
| `maxBytes`     | 1 MiB                                            | A hard ceiling, not a target                                                             |
| JPEG `quality` | `"balanced"`                                     | q80 4:2:0; `"small"` = q65 4:2:0, `"high"` = q90 4:4:4; q80 is the cross-tool convention |
| PNG `effort`   | `"fast"` in `encodePng`, `"strong"` in the verbs | 5× time for 20–60% fewer bytes is a real boundary                                        |

Numeric scales (zlib 0–9, zstd −8…22) belong to the implementation; a pure-JS codec has a couple of boundaries worth naming. JPEG quality keeps the IJG number because "q80" is an interop convention users already speak. The JPEG size ladder is 80 → 72 → 65 → 58 → 50 → 42 → 35, walked at each ×0.8 downscale to a 256 px floor: below q35 shrinking pixels beats shredding them. Optimized Huffman tables are always on; progressive JPEG is opt-in (decoder memory cost, baseline is the default expectation).

## Safety limits (fixed, not options)

- `maxPixels` (default 50,331,648 = 8192 × 6144) bounds the total pixels one call may materialize, every animation frame included, checked against the header before allocating. JPEG counts width × height; 48–50 MP 4:2:0 phone photos fit. A 23-byte JPEG header used to reserve 768 MB under the older 16384² default; a 6 KB GIF with 250 tiny frames decoded to 250 MB before the frame count was budgeted.
- JPEG: more than 100 scans throws (libjpeg-turbo's fuzz harness sets `TJPARAM_SCANLIMIT` to 100); a scan whose data runs out stops instead of walking the whole image (3000 empty scans in a 62 KB file took 29 s before).
- PNG inflate is capped at the exact scanline size; `iCCP` / `iTXt` at 16 MB and only the first `iCCP` is read. GIF LZW is capped at the frame rectangle.

## Cost

Pure JS, single-threaded, roughly 5–10× slower than libvips/sharp. `shrinkImage` of a 12 MP JPEG to 2048 px: ~1–3 s; RGBA at 50 MP is 200 MB, so a 128 MB isolate should pass `maxPixels` ≈ 16 MP. Calls are synchronous and whole-buffer: run them in a Worker.
