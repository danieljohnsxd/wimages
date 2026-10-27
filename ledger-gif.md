# GIF ledger

Decisions for the GIF codec. Date of this snapshot: 2026-08-27 (supersedes 2026-08-16).

## Product

GIF is the meme / interchange animation format (see `ledger-apng.md`). wimgs ships GIF89a encode + GIF87a/GIF89a decode. Pixels in, bytes out. Same `PixelBuffer` as PNG.

- `encodeGif(image: PixelBuffer | readonly GifFrame[], options?): Uint8Array`
- `decodeGif(bytes, options?: { maxPixels?: number }): { width, height, frames, delays, loop }`

`loop` is `0` forever, `n` for n plays, `undefined` when the file has no NETSCAPE block (play once). `delays` are **milliseconds** (the file stores centiseconds; ×10 on read, ÷10 rounded on write) so GIF and APNG share one unit; a file’s 0 is reported as 0 — browsers render ≤10 ms as 100 ms, and the product layer applies that rule only when converting between containers.

## Still vs animation

`encodeGif(pixelBuffer)` is a still: GIF89a, no NETSCAPE unless `options.loop` is set. GCE only when the palette has alpha < 255 (disposal 1, delay 0).

`encodeGif(frames)` is animation: canvas size = first frame; every frame must match that size. NETSCAPE 2.0 only if `loop` is set — `undefined` means play once, exactly what the file would say (the earlier “multi-frame defaults to loop 0” turned play-once GIFs into infinite loops). Per-frame delay default 100 ms.

### Frame optimization — always on for animations

Naive GIF animation (independent full-canvas frames) is 5–12× larger than it needs to be, and every consumer would otherwise reinvent gifsicle. So animations are always planned the way `gifsicle -O2/-O3` plans them, and the result is **lossless in the rendered canvases**:

1. Snap every frame to its palette (same quantize/dither path as stills) so the target is “independent full frames”.
2. Merge identical consecutive frames (delays add; 65535-centisecond cap).
3. Walk the decoder’s canvas state: crop each frame to its dirty rectangle; unchanged pixels inside it become the transparent index when a slot exists.
4. Disposal per frame is 1 (leave) or 2 (restore to background = clear to transparent) — 2 when the next frame must reveal transparency (the rect is expanded so those pixels clear), otherwise whichever gives the smaller next dirty rect. Disposal 3 is never emitted.
5. Partial image descriptors. Palettes keep the `"local" | "global"` rule.

User `disposal` on multi-frame input is ignored: the planner owns it. Measured: 20 frames of a 40×40 sprite over a 200-color noisy 200×200 background — 152 KB as stills, **12.7 KB** optimized.

Skipped from gifsicle -O3 (revisit if a consumer measures a need): transparent-run LZW heuristics (compress twice, keep smaller), global-colormap penalty/permutation, interlace stripping.

`optimizeGif(bytes)` = `decodeGif` → `encodeGif(frames, { palette: "local" })`. Per-frame tables have ≤ 256 colors, so the median-cut keeps exact colors and the pass is lossless. Returns the input when it cannot beat it. `optimizeImage` uses the same rewrite but, with `keepMetadata: false`, never returns input bytes that still carry comment or XMP extensions: it drops comment (0xFE) and application extensions other than NETSCAPE2.0 / ANIMEXTS1.0 / ICCRGBG1012, and bytes after the trailer, at the block level.

The nearest-color mapper (and the PNG quantizer it shares) searches the palette in red order outward and stops once the red gap alone exceeds the best distance — exact, same ties (lowest index), ~2.5× faster GIF encodes on photographic frames.

### LZW code-width at EOI

When the last dictionary entry lands exactly on 2^n, decoders widen the code size _before_ reading EOI. The encoder must write EOI at the widened width. Ours didn't (6×4 checkerboard stills failed to decode) — fixed, and pinned by a test.

## Palette

Reuse PNG `quantizeToPalette` (median-cut in RGBA) on **opaque pixels only**. Default `maxColors` 256. Do not fork the cut.

### Transparency: one reserved slot

GIF has one transparent index, not 8-bit alpha. Every pixel with `alpha < 128` maps to a single dedicated transparent entry, regardless of its RGB; the color palette is built from the opaque pixels alone (255 colors when the table is full). The previous rule — pick the lowest-alpha palette color as “the” transparent index — meant a second transparent color with a different RGB snapped to an _opaque_ entry (transparent red + transparent blue → blue came back opaque). Alpha ≥ 128 is opaque.

When any frame has transparency, the logical-screen background color index is the transparent slot, so “restore to background” (disposal 2) reveals nothing rather than an opaque color.

### Animation palettes: `palette: "local" | "global"`

Default `"local"`: frame 0 builds the global color table; each later frame reuses it when its opaque colors are a subset (and the transparent slot exists if needed), otherwise it gets its own local color table. Disjoint-palette frames roundtrip exactly instead of sharing 256 colors across the whole animation. `"global"` is the old behavior — one median-cut over all frames, one GCT, smaller files when frames share colors.

### Dithering: `dither: "none" | "floyd-steinberg"`

Default `"none"` (exact nearest-color snap, byte-stable output). Floyd–Steinberg diffuses error against the chosen palette over opaque pixels only; transparent pixels neither receive nor propagate error. Per-pixel nearest snap already minimizes point-wise MAE, so the test measures 4×4 block-mean error (≈0.8 dithered vs ≈5.4 snapped on a gradient) — that is what banding looks like.

GCT is RGB, padded to a power of two in 2..256. LZW min code size = `max(2, table bits)`.

## LZW

Own LSB-first bit packer in `src/gif/lzw.ts`. Do not use the deflate `BitWriter` (same LSB bit order, different framing). Clear at start, EOI at end, 255-byte sub-blocks, reset when the table hits 4096.

## Decode

Composites onto an RGBA canvas (starts fully transparent). Transparent index **skip-draws** (previous / undrawn shows through → alpha 0 on stills). Output frames are full-canvas RGBA snapshots.

- Disposal 2: clear the frame rectangle to **transparent** `RGBA(0,0,0,0)`. Browsers never paint the LSD background color; neither do we (the old “opaque GCT background” rule made transparent frames opaque).
- Disposal 3: restore the previous canvas if we saved it; otherwise treat as 2.
- Interlace: GIF four-pass row interlace (not PNG Adam7).
- Local + global color tables, per-frame transparent index. NETSCAPE / ANIMEXTS loop.
- `maxPixels` (default 50 MP) bounds the **total** pixels decoded: the canvas is allocated only at the first image descriptor, and every additional full-canvas frame is counted (`frames × w × h`) before allocation, so a 6 KB file with 250 tiny frames on a 512² canvas throws instead of materializing 250 MB. Frame rectangles must lie inside the logical screen. LZW output is capped at the frame rectangle.

Lossy palette: solids and checkerboards can be exact. Photographs will snap — turn on `dither`.
