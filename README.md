# wimages

Pure TypeScript image codecs and a photo-upload shrinker. PNG, APNG, JPEG, GIF; ES2022 ESM; typed arrays in and out. No Rust, no WASM, no canvas, no `node:*` — the same build runs in Node 22+, Deno, Bun, Cloudflare Workers, Convex actions, Web Workers, and evergreen browsers.

```ts
import { shrinkImage } from "wimages";

// Photo upload path: ≤ 2048 px long side, ≤ 1 MiB, upright, JPEG for photos / PNG for graphics.
const { bytes, format, width, height } = shrinkImage(uploadBytes, {
  maxSide: 2048,
  maxBytes: 1 << 20,
});
```

That one call is the product: an upload that comes out the other side looking the way the user expects — upright, same colors, still animated if it was animated, no GPS in the EXIF.

## When to use this

- **Use it** where native image libraries are unavailable or unwelcome: Cloudflare Workers, Convex actions, Deno Deploy, a Web Worker, an edge function, a server that should not ship libvips. It is the upload path — `shrinkImage` before storing, `optimizeImage` for lossless archiving.
- **Use `sharp`/libvips instead** when you run on a normal server and process many images per second: native is 5–10× faster and has more formats. In a browser, a `<canvas>` re-encode is faster for a one-off resize, but it drops animation and metadata choices and gives you no byte budget.
- **Not for** WebP / AVIF / HEIC output, thumbnail sprites, crops, or color management. Decoding WebP / AVIF / HEIC throws a named error.
- **Bytes that are not images** (JSON, logs, archives): use the sibling packages — [`wgzip`](https://www.npmjs.com/package/wgzip) for gzip/deflate everywhere, [`wzstd`](https://www.npmjs.com/package/wzstd) for zstd. Already-compressed images do not get smaller under either.

An agent skill ships in the package: [`skills/image-uploads/SKILL.md`](skills/image-uploads/SKILL.md).

## Which format?

`shrinkImage` picks for you (`format: "auto"`); this is the rule it follows, and the one to follow if you choose yourself:

| Content                                       | Format                          | Why                                                                                                                |
| --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Photo (camera, many colors, no alpha)         | JPEG                            | Smallest at a quality nobody notices; every viewer opens it                                                        |
| Screenshot, UI, diagram, logo, text           | PNG                             | Lossless; flat areas compress far better than JPEG and stay sharp                                                  |
| Anything with transparency                    | PNG                             | JPEG has no alpha (it would be composited on white)                                                                |
| Animation, memes, reaction GIFs               | GIF                             | Plays everywhere; an animated upload stays an animation (not a video, not a still)                                 |
| Animated sticker / emoji with real alpha      | APNG (`format: "png"` on a GIF) | 8-bit alpha and full color; the sticker format of Discord, iMessage, Signal; non-APNG viewers show the first frame |
| Archive, "make it smaller but change nothing" | `optimizeImage` (same format)   | Pixel-identical; JPEG is rewritten at the coefficient level, never re-quantized                                    |

WebP, AVIF and HEIC are not output formats here: there is no pure-JS encoder worth shipping for them, and JPEG/PNG/GIF open everywhere an upload ends up. iPhone HEIC photos arrive as JPEG when the file input accepts `image/jpeg`.

## Design choices

- **Two verbs, split by loss.** `optimizeImage` never changes a pixel; `shrinkImage` does whatever it takes to fit `maxSide` / `maxBytes`. A flag that silently changes what "optimize" means was rejected.
- **Opinionated defaults, few options.** 2048 px, 1 MiB, JPEG q80 4:2:0, PNG for graphics and alpha, animations stay animated. Presets (`"fast" | "strong"`, `"small" | "balanced" | "high"`) instead of numeric levels, because a pure-JS codec has only a couple of boundaries worth naming.
- **Privacy by default, colors intact.** EXIF (GPS, device, time), XMP and text chunks are stripped unless `keepMetadata: true` — including when `optimizeImage` cannot beat the input and hands back the original bytes (they are stripped in place first). The ICC profile is kept: it defines the colors (Display P3 photos and screenshots go dull without it) and says nothing about the user. Orientation is kept as a tag or baked into the pixels.
- **Safety caps are fixed, not knobs.** One `maxPixels` budget (default 50 MP) on every decoder, counted before allocating; JPEG files with more than 100 scans are rejected (libjpeg-turbo's fuzzing limit); every inflate is capped at the size the header promised.

The codecs underneath are exported too:

```ts
import { decodeImage, resize, encodeJpeg, encodePng, encodeGif, decodeGif } from "wimages";

const { image, format, animated } = decodeImage(bytes); // sniffs PNG / JPEG / GIF, applies EXIF orientation, first frame of animations
const small = resize(image, { maxSide: 1024 }); // Lanczos3, premultiplied alpha, never upscales
const jpg = encodeJpeg(small, { quality: "balanced" }); // "small" | "balanced" | "high" | number
const png = encodePng(small, { effort: "strong" }); // "fast" (default) | "strong"
const gif = encodeGif([frameA, frameB], { loop: 0, dither: "floyd-steinberg" }); // loop 0 = forever; omit = play once
```

`PixelBuffer` is `{ width, height, data }` — packed 8-bit RGBA, 4 bytes per pixel, row-major. Pass your own `Uint8Array`; `createPixelBuffer` just allocates zeros.

## Presets, not knobs

Numeric scales like zlib's 0–9 or zstd's −8…22 belong to the implementation. A pure-JS codec has only a couple of boundaries the runtime actually exposes, so the API names those and nothing else:

| Option               | Values                                | Default      | What it means                                                                                                                     |
| -------------------- | ------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `encodePng.effort`   | `"fast"` \| `"strong"`                | `"fast"`     | fast: fixed filter, level-2 deflate. strong: adaptive filters + lazy LZ77, 15–60% smaller, ~5× slower — what `optimizeImage` uses |
| `encodeJpeg.quality` | `"small"` \| `"balanced"` \| `"high"` | `"balanced"` | small = q65 4:2:0, balanced = q80 4:2:0, high = q90 4:4:4. A number is the IJG 1–100 scale                                        |
| `encodeGif.dither`   | `"none"` \| `"floyd-steinberg"`       | `"none"`     | error diffusion for photographic content                                                                                          |

Optimized Huffman tables are always on for JPEG; there is no option because there is no reason to turn them off.

## API

### `optimizeImage(bytes, options?)` → `{ bytes, format, animated, changed }` — lossless

Identical pixels, smaller file. PNG is re-encoded at `"strong"` with the smallest exact color type; JPEG is re-entropy-coded at the coefficient level (`transcodeJpeg` — what `jpegtran -optimize` does; no decode, no generation loss; `progressive: true` optional); animated GIF and APNG are re-planned frame by frame (dirty rectangles, duplicate frames merged — what `gifsicle -O3` does); 16-bit PNG keeps its samples. If the rewrite would not be smaller, your original bytes come back — with their EXIF / XMP / text segments cut out in place unless `keepMetadata: true` (`changed: true`), or untouched when there was nothing to cut (`changed: false`).

| Option         | Default | Notes                                                                                                                                                                                             |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keepMetadata` | `false` | `false` strips EXIF / XMP / comments / text chunks and keeps the ICC profile (JPEG and PNG keep a one-tag orientation EXIF so the file still displays upright). `true` carries everything through |
| `progressive`  | `false` | JPEG only                                                                                                                                                                                         |
| `maxPixels`    | 50 MP   | Decode guard: total pixels the call may materialize, frames included (see _Hostile input_)                                                                                                        |

### `shrinkImage(bytes, options?)` → `{ bytes, format, width, height, animated, lossless }` — lossy

| Option         | Default      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSide`      | 2048         | Longest side after shrinking; never upscales                                                                                                                                                                                                                                                                                                                                                                                        |
| `maxBytes`     | 1 MiB        | Hard ceiling. JPEG walks the quality ladder (80→72→65→58→50→42→35) at each resolution, then downscales ×0.8 and walks it again, down to a 256 px long side; PNG tries full color then 256 colors; animations reduce colors, then drop every other frame (delays summed, duration kept), then downscale. Throws if it cannot fit at the floor                                                                                        |
| `format`       | `"auto"`     | `"auto"`: JPEG stays JPEG; alpha or ≤ 256 colors → PNG; animations stay GIF or APNG; a PNG/GIF with more colors becomes JPEG only if it looks photographic (fewer than 15% of pixels equal their left neighbor — screenshots and UI stay PNG). `"keep"`: same container as the input, whatever the content. `"jpeg"` / `"png"` / `"gif"` force (an animation forced to JPEG becomes its first frame; forced to PNG becomes an APNG) |
| `quality`      | `"balanced"` | JPEG starting point                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `keepMetadata` | `false`      | As above (ICC kept by default); on the lossy path the EXIF orientation tag is rewritten to 1 because the rotation is baked into the pixels                                                                                                                                                                                                                                                                                          |
| `maxPixels`    | 50 MP        | Decode guard, frames included                                                                                                                                                                                                                                                                                                                                                                                                       |

Output bytes are always freshly produced — never your original — so the result is safe to store and contains exactly the metadata you asked for. If the image already fits, it takes the lossless path (`lossless: true`, pixels identical); otherwise it is resized / re-quantized (`lossless: false`).

### Codecs

| Function                                                                       | Notes                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeImage(bytes, { maxPixels? })`                                           | Sniffs the format, returns `{ image, format, animated }` — the first frame of an animation, with `animated: true` so you know. `sniffImageFormat(bytes)` is exported separately; WebP / HEIC / AVIF / BMP / TIFF are named in the error |
| `resize(image, { maxSide } \| { width, height })`                              | Separable Lanczos3 (or `filter: "box"`), premultiplied alpha, returns the same object when nothing changes. `upscale: false` by default                                                                                                 |
| `encodePng(image, { effort?, colorType?, maxColors? })`                        | `colorType` `"auto"` picks the smallest exact representation (gray content goes to gray, never to an indexed image with a PLTE it doesn't need); `maxColors` 2–256 is lossy median-cut                                                  |
| `decodePng(bytes, { maxPixels?, orientation? })`                               | All color types and depths, Adam7, `tRNS`; 16-bit → 8-bit; first frame of an APNG; `eXIf` orientation applied like JPEG. libpng-style leniency: ancillary CRC errors skipped, bytes after `IEND` ignored, critical failures throw       |
| `encodeJpeg(image, { quality?, chroma?, progressive?, background? })`          | Baseline or progressive (libjpeg-turbo scan script), 4:2:0 / 4:2:2 / 4:4:4, alpha composited onto `background` (white)                                                                                                                  |
| `decodeJpeg(bytes, { maxPixels?, orientation?, upsample? })`                   | Baseline + progressive, restart markers, 1/3/4 components (CMYK/YCCK via APP14), EXIF `orientation: "apply"` (default) \| `"ignore"`, `upsample: "fancy"` (libjpeg triangle filter, default) \| `"nearest"`                             |
| `encodeGif(image \| frames, { maxColors?, loop?, palette?, dither? })`         | `palette: "local"` (per-frame tables when needed, default) \| `"global"`; per-frame `delay` (ms, rounded to 10 ms) / `disposal`; `loop` omitted = play once, `0` = forever, `n` = n times                                               |
| `decodeGif(bytes, { maxPixels? })`                                             | GIF87a/89a, local + global tables, disposal 1–3, interlace, per-frame transparency → `{ width, height, frames, delays, loop }`; `delays` in ms (same unit as APNG; a file's 0 stays 0 — browsers show it as 100 ms)                     |
| `quantizeToPalette(data, width, height, n)`                                    | The median-cut used by `maxColors`                                                                                                                                                                                                      |
| `encodeApng(frames, { loop?, effort? })` / `decodeApng(bytes, { maxPixels? })` | APNG with the same frame planner as GIF (dirty rectangles, dispose/blend chosen per frame); decode composites like a browser → `{ width, height, frames, delays, loop }`. `isAnimatedPng(bytes)` checks for `acTL` without decoding     |
| `transcodeJpeg(bytes, { progressive?, metadata?, maxPixels? })`                | Lossless JPEG rewrite (`jpegtran -optimize [-progressive] -copy none`); what `optimizeImage` uses                                                                                                                                       |
| `optimizeGif(bytes, { maxPixels? })`                                           | Lossless GIF frame re-plan → `{ bytes, changed }`; what `optimizeImage` uses (without its metadata stripping)                                                                                                                           |
| `readImageMetadata(bytes, { maxPixels? })`                                     | `{ exif?, icc?, xmp? }` raw payloads from PNG / JPEG; `exifOrientation(exif)` and `withExifOrientation(exif, n)` read and rewrite the orientation tag                                                                                   |
| `fitSize(w, h, maxSide)`, `createPixelBuffer(w, h)`, `DEFAULT_MAX_PIXELS`      | The size math `resize` uses, a zeroed RGBA buffer, and the default decode budget (50,331,648)                                                                                                                                           |

Not supported, thrown immediately with a message that names the variant: arithmetic-coded, lossless (SOF3), hierarchical, and 12-bit JPEG; WebP, AVIF, HEIC, BMP, TIFF (iOS converts HEIC to JPEG at a file input that accepts `image/jpeg`).

## Subpath imports

The root export tree-shakes (`sideEffects: false`), and there are explicit entry points for bundler-less use or when you want intent visible:

| Import           | Contents                                                          |
| ---------------- | ----------------------------------------------------------------- |
| `wimages`        | everything, including `optimizeImage` / `shrinkImage`             |
| `wimages/png`    | `encodePng`, `decodePng`, `quantizeToPalette`, APNG, PNG metadata |
| `wimages/jpeg`   | `encodeJpeg`, `decodeJpeg`, `transcodeJpeg`, JPEG metadata        |
| `wimages/gif`    | `encodeGif`, `decodeGif`, `optimizeGif`, `quantizeToPalette`      |
| `wimages/resize` | `resize`, `fitSize`                                               |

Sizes of the full module graph each entry pulls in (minified / gzip): `wimages` ~116 KB / 38 KB, `wimages/png` 45 / 15, `wimages/jpeg` 41 / 14 (no PNG inflater), `wimages/gif` 22 / 8, `wimages/resize` 7 / 2.5.

## Scope and limits — read before adopting

**Synchronous, whole-buffer.** No streaming or incremental API. Each call holds input, output, and working set at once and does not yield — run it in a Worker (Web Worker, `worker_threads`, a Workers/Convex isolate) if a UI thread is nearby.

**Memory** (beyond input + output):

| Operation   | Extra memory                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JPEG encode | 2 bytes per sample (Int16 coefficients) + MCU scratch                                                                                                             |
| JPEG decode | 1 byte per component sample; progressive adds 2 bytes per sample until the last scan                                                                              |
| PNG encode  | filtered scanlines (1 × input) + LZ77 hash chains + growing output — ~3 × input at `"strong"`                                                                     |
| PNG decode  | inflated scanlines (≈ 1 × output for 8-bit RGBA, unfiltered in place); peak ≈ 2 × the RGBA output (8192 × 6144: 463 MB max RSS for a 201 MB image, Node included) |
| resize      | one `Float32` intermediate of the intermediate size (dstW × srcH)                                                                                                 |
| GIF / APNG  | one full-canvas RGBA frame per output frame (`frames × width × height × 4`) + one index plane                                                                     |

A 12 MP JPEG round-trips inside a 128 MB Cloudflare Worker (48 MB RGBA + ~45 MB working set). A 12 MP PNG encode does not; `shrinkImage` resizes first, which is the right order anyway.

**Hostile input.** Every decoder takes `{ maxPixels }` — default 50,331,648 (8192 × 6144; 48–50 MP phone photos such as 8160 × 6120 fit) — and it bounds the _total_ image pixels one call may materialize: every frame of a GIF/APNG counts. For JPEG it is width × height like everywhere else; the coefficient store adds at most 2 bytes per component sample on top (structurally bounded by the MCU-padded grid). It is checked before anything sized by a header is allocated, so a 23-byte JPEG header or a 6 KB GIF with 250 tiny frames on a 512² canvas throws instead of reserving hundreds of MB. A JPEG with more than 100 scans throws (libjpeg-turbo's fuzzing limit), and a scan whose entropy data runs out stops there instead of walking the whole image. PNG inflate is capped at the exact scanline size (also `iCCP`/`iTXt`), GIF LZW at the frame rectangle. `shrinkImage` honors a `maxPixels` above the default all the way through the resize. On a 128 MB isolate (Cloudflare Workers) pass `maxPixels: 16_000_000` or so; RGBA at 50 MP is 200 MB.

**Throughput.** Pure JS, single-threaded, roughly 5–10× slower than libvips/sharp. `pnpm build && node --expose-gc scripts/bench.ts` on a synthetic 4000×3000 photo, Node 24, Apple Silicon. Ranges are idle → busy machine (min of 3 runs at load average 12); budget for the high end.

| Operation (12 MP)                    | Time                  | Extra RSS       | Output  |
| ------------------------------------ | --------------------- | --------------- | ------- |
| `shrinkImage` (12 MP JPEG → 2048 px) | 1.0–3.1 s             | +17 MB          | 268 KB  |
| `optimizeImage` (12 MP JPEG)         | 0.25–0.5 s            | +5 MB           | 1.8 MB  |
| `resize` → 2048 px (Lanczos3)        | 0.33–0.7 s            | +99 MB\*        |         |
| `encodeJpeg` balanced                | 0.7–1.5 s             | +41 MB          | 1.8 MB  |
| `encodeJpeg` high (q90 4:4:4)        | 1.3–2.9 s             | +55 MB          | 4.4 MB  |
| `encodeJpeg` progressive             | 1.3–2.9 s             | ~+40 MB         | 1.7 MB  |
| `decodeJpeg` baseline / progressive  | 0.6–1.6 s / 0.9–1.7 s | +46 MB / +52 MB |         |
| `encodePng` fast (default)           | 2.4–5.2 s             | +140 MB         | 13.5 MB |
| `encodePng` strong                   | 12–27 s               | ~+150 MB        | 11.1 MB |
| `decodePng`                          | 0.6–1.3 s             | +25 MB          |         |

\* RSS deltas are what the OS reports around one call after a forced GC; the 48 MB RGBA input is not included, and negative/low readings mean the allocator reused a previous call's pages. The resize figure is the Float32 intermediate plus the 2048×1536 output.

Fine for edge functions, upload paths, and anywhere native binaries are off the table. Not for a hot path doing hundreds of photos per second on one core.

## Design notes

Decisions and their reasons live in `ledger-<format>.md`: [PNG](ledger-png.md), [JPEG](ledger-jpeg.md), [GIF](ledger-gif.md), [APNG](ledger-apng.md), [image (shrink/resize)](ledger-image.md), and [review](ledger-review.md) — the five-lens review (HN skeptic, hostile input, edge cases, test suite, differential oracle) and what it caught. `AGENTS.md` has the engineering constraints and the API philosophy.

## Development

```bash
pnpm check   # oxfmt --check + oxlint (type-aware)
pnpm test    # tsdown build + node --test
pnpm build   # dist/
pnpm bench        # README throughput table (node --expose-gc scripts/bench.ts)
pnpm bench:check  # perf regression guards with generous limits (not part of pnpm test)
```

Node ≥ 24 and pnpm for development (tests run `.ts` directly); the emitted ESM needs Node ≥ 22. Tests import the public API from `dist/` (including each subpath); fixtures (libjpeg-turbo outputs, independently written PNGs, hand-built streams) are embedded, and `node:zlib` is the only external oracle used at test time — every PNG the encoder produces in the suite is inflated by it.

MIT.
