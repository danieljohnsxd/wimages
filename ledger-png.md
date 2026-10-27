# PNG ledger

Decisions for the still-PNG codec. Update this file when behavior changes.
Date of this snapshot: 2026-08-27 (supersedes 2026-08-16).

## Product

This ledger covers the PNG **codec** (pixels ↔ bytes). The upload shrinker built on it (`shrinkImage`, `optimizeImage`) is in `ledger-image.md`.

- `encodePng(image: PixelBuffer, options?: { effort?, colorType?, maxColors? }): Uint8Array`
- `decodePng(bytes: Uint8Array, options?: { maxPixels?: number; orientation?: "apply" | "ignore" }): PixelBuffer` — `eXIf` orientation is applied by default, same as JPEG.

`PixelBuffer` is `{ width, height, data }` packed 8-bit RGBA, 4 bytes/pixel, row-major.
`createPixelBuffer` only allocates zeros. Callers who already have a `Uint8Array` pass the object literal. Do not make the allocator the API.

No `CompressionStream`, no `node:zlib`, no canvas, no WASM in `src/`.

## Encode / decode pairing

Study oracles that are codecs (`@jsquash/png`, `@cross/image`, UPNG) always ship both directions.
Compressor-only tools (oxipng, browser-image-compression) do not; they rewrite bytes or decode in the host.

We ship both. Decode is required for roundtrips, Workers, and “shrink this PNG” without a browser decoder.

## Pipeline (shared)

```
RGBA
  → (optional) quantizeToPalette     // lossy, maxColors 2–256
  → analyzeRgba                      // lossless color-type pick
  → packScanlines                    // gray/rgb/rgba/palette + bit depth
  → filterImage                      // none/sub/up/average/paeth/adaptive
  → zlibDeflate                      // LZ77 + Huffman, our code
  → signature + IHDR + PLTE? + tRNS? + IDAT + IEND
```

Decode is the reverse and **reuses** CRC/chunks, `unfilterImage` (inverse of `filterImage`), and `zlibInflate`. Palette packing is inverted in `decode.ts`, not duplicated as a second writer.

## Color type (lossless)

Auto pick, smallest exact representation:

| Condition                                | Kind         | Bit depth                                                       |
| ---------------------------------------- | ------------ | --------------------------------------------------------------- |
| Opaque gray                              | `gray`       | 1 if {0,255}; 2 if {0,85,170,255}; 4 if multiples of 17; else 8 |
| Opaque gray, ≤ 256 unique, PLTE pays off | `palette`    | 1/2/4/8 from count — only if payload + PLTE < gray payload      |
| Unique RGBA ≤ 256, not opaque gray       | `palette`    | 1/2/4/8 from count                                              |
| Gray + alpha, > 16 unique                | `gray-alpha` | 8                                                               |
| Opaque color, > 256 unique               | `rgb`        | 8                                                               |
| Else                                     | `rgba`       | 8                                                               |

Gray beats palette for gray content: `gray` at depth 1/2/4/8 is always exact and never needs the 6–768-byte PLTE. The old rule (“palette whenever ≤ 256 colors, even for gray”) inflated a 256-shade 64×64 gradient by ~48%. Palette is still chosen for gray when the **packed scanlines plus `3 × palette.length`** are strictly smaller (16 irregular shades at 4 bpp vs 8-bit gray); ties go to gray. The comparison ignores zlib and chunk overhead — enough to get the two obvious cases right.

Force via `colorType`. Palette > 256 unique throws. `tRNS` only for palette alphas (not a single RGB key… yet).

Photographs with > 256 colors stay RGB/RGBA. That is lossless PNG, not pngquant.

## Effort: `"fast" | "strong"` (was `level` 0–9 + `filter`)

The 0–9 scale is zlib’s, not the user’s. In this implementation there are exactly two configurations worth naming:

| Effort             | Deflate                                  | Filter                                                         |
| ------------------ | ---------------------------------------- | -------------------------------------------------------------- |
| `"strong"`         | level 9: lazy matching, deep hash chains | adaptive per row (min sum of abs deviations, tie → lower type) |
| `"fast"` (default) | level 2: greedy, short chains            | `sub` on every row                                             |

Measured (Node 24, Apple Silicon): 2048×1536 screenshot — fast 71 ms / 10 KB, strong 392 ms / 4 KB; 2048×1536 photo — fast 0.7 s / 5.0 MB, strong 1.9 s / 4.3 MB; 12 MP photo — fast 2.5 s / 13.5 MB, strong 12.4 s / 11.1 MB.

`encodePng` defaults to `"fast"` (see the review round below: a 12 MP `"strong"` encode took ~20 s, too slow for a codec default). `"strong"` is what the product verbs use, because bytes out is their product and at upload sizes (≤ 2048 px) it costs well under half a second on the content people actually PNG (screenshots, graphics). The 12 MP-photo-as-PNG case is the wrong tool; `shrinkImage` routes photos to JPEG. Level 2 was chosen over 3 for fast: same size class, ~10% faster, never larger on photo-like content.

The deflate module keeps its internal 0–9 table (tests exercise 0 and 6 directly); only two entries are reachable from the public API.

## Deflate

Own RFC 1951 + zlib wrapper (CMF/FLG + Adler-32). PNG IDAT requires zlib, not raw deflate.

- Level 0: stored blocks
- 1–9: LZ77 (32K, hash chains, lazy match) then pick stored / fixed Huffman / dynamic Huffman by estimated size
- Huffman codes reversed for LSB-first bit IO
- Inflate must not count Huffman-peek leftover bytes as consumed, or Adler-32 looks truncated
- **`alignToByte()` must rewind `index` by the peeked whole bytes** before zeroing the accumulator. A 15-bit Huffman peek can pull two bytes past the block end; a stored block that follows then reads LEN/NLEN from the wrong place. This bit our own encoder’s output (`inflateRaw(deflateRaw(x))` failed for “compressible then random” inputs) — pinned by a hand-built 15-bit-dynamic → stored fixture in `tests/deflate_test.ts`.
- `inflateRaw` / `zlibInflate` take an optional `maxOutput`; the output buffer never grows past it (decompression-bomb guard).

Do not share the JPEG bit writer: JPEG is MSB-first.

## Quantization (lossy)

`maxColors: 2–256` → median-cut in RGBA → remapped pixels + `ColorAnalysis { kind: "palette", ... }` → **same** `packScanlines`. No second PNG writer.

If unique colors already ≤ `maxColors`, keep exact colors (lossless indexed).

Export `quantizeToPalette` so GIF (and tests) can reuse the remapper. PNG-specific `ColorAnalysis` stays in `src/png/color.ts`; if GIF wants indexes without PNG kinds, wrap rather than fork the cut.

Not Wu / pngquant quality. Good enough for logos and “make it indexed”. Revisit if photos are a named goal.

## Interlace (Adam7)

Decode: yes (7 passes, scatter into RGBA). Encode: always sequential (`IHDR` interlace 0). Adam7 usually **grows** files; it is a progressive-display trick, not a compressor.

## APNG

See `ledger-apng.md` — shipped. `decodePng` stays first-frame-only (the spec fallback); `decodeApng` / `encodeApng` live in `src/png/apng.ts` and reuse this codec's chunk, color-type, filter and deflate paths.

## 16-bit

Decode 16-bit samples as high byte → 8-bit RGBA. Encode is 8-bit only. `PixelBuffer` is 8-bit; we are not in the 16-bit PNG business.

## Metadata

`encodePng(image, { metadata })` writes `iCCP` (zlib, method 0, before PLTE), `eXIf`, and `iTXt` `XML:com.adobe.xmp`; `readImageMetadata` reads them back (`src/png/metadata.ts`, shared `ImageMetadata` type in `src/metadata.ts` with JPEG). Nothing else is preserved — text chunks, `pHYs`, `tIME`, `gAMA`/`cHRM`/`sRGB` are dropped on re-encode. ICC is the one that changes how pixels _look_; EXIF and XMP are what tools and people expect to survive. If a consumer needs `pHYs`, that is a one-line addition, not a design change.

Default on every product verb strips EXIF and XMP and **keeps ICC** (2026-10 review: stripping ICC without converting to sRGB made Display P3 photos and screenshots render dull; the profile is how the pixels look, not information about the user). `keepMetadata: true` carries everything. When `optimizeImage` falls back to the input bytes it drops `eXIf` (re-emitted as a one-tag orientation `eXIf` when needed), `tEXt`, `zTXt`, `iTXt`, `tIME` and anything after `IEND` at the chunk level, without re-encoding. `readImageMetadata` inflates only the first `iCCP` (PNG allows one) so repeated corrupt profiles cost one capped inflate, not one each.

## Decode strictness

Match libpng / browsers, not the letter of the spec:

| Situation                                       | Behavior                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| Bad CRC on critical chunk (IHDR/PLTE/IDAT/IEND) | throw                                                                    |
| Bad CRC on ancillary chunk (tEXt, tRNS, gAMA…)  | skip the chunk, keep decoding (bad tRNS → no tRNS)                       |
| Bytes after IEND                                | ignored (stego tools and old crushers append junk)                       |
| Missing IEND                                    | throw `PNG is missing IEND`                                              |
| Bad Adler-32                                    | throw                                                                    |
| `width × height > maxPixels` (default 50 MP)    | throw before any allocation (16-bit also counts the raw scanline buffer) |
| IDAT inflates past `height × (1 + rowBytes)`    | throw (`maxOutput` on the inflater)                                      |

## Tests

`tests/` import `../dist/`. Library decode is the roundtrip oracle. `node:zlib` may inflate IDAT in tests as a second check that our zlib is standard. Do not put `node:*` in `src/`. `decodePng` is pixel-exact against macOS ImageIO (`sips`) rasterization in ad-hoc checks.

## Files

```
src/pixels.ts
src/limits.ts
src/png/{crc32,chunk,color,pack,filter,quantize,encode,decode}.ts
src/deflate/{adler32,bits,tables,huffman,lz77,deflate,inflate,zlib}.ts
```

## Not doing (PNG)

- Adam7 encode
- Auxiliary chunks other than `iCCP` / `eXIf` / XMP `iTXt` (pHYs, gAMA/cHRM/sRGB, text) on re-encode
- CompressionStream fallback
- Quantizing to RGB instead of palette

## Decode memory (2026-10)

`unfilterImage` reverses the filters in place in the inflated buffer and hands out row views; it used to copy every row, so a decode peaked at ~3 × the RGBA output (inflated + rows + RGBA). Now ~2 × (8192 × 6144 RGBA: max RSS 667 → 463 MB, 1.9 → 1.0 s).

## Review round (2026-08)

- **Default `effort` is `"fast"`.** A 12 MP `encodePng()` at `"strong"` took ~20 s; a codec call that slow by default is a footgun. `"strong"` stays the choice of `optimizeImage`, which is the verb whose contract is bytes-out.
- **Deflate completeness.** The differential review found `encodePng` output that our own inflater accepted but `node:zlib` and ImageIO rejected (`invalid code lengths set`): the length limiter left incomplete Huffman codes. Fixed in `src/deflate/huffman.ts` (zlib `gen_bitlen` overflow repair; Kraft sum exactly 1). The suite now inflates every produced IDAT with `node:zlib`.
- Independent fixtures (Adam7, Paeth, 16-bit, palette+tRNS) written by a separate encoder in `tests/png_decode_helper.ts`; IHDR CRC mismatch throws, ancillary CRC mismatch is tolerated, trailing bytes ignored.
- All inflates (IDAT, fdAT, iCCP, iTXt) are capped; compressed iTXt XMP is read.
