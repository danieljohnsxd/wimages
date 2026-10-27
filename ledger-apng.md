# APNG ledger

Date of this snapshot: 2026-08-27. **Reverses the 2026-08-16 skip decision.**

## Decision

Ship APNG: `decodeApng` (all frames, browser-exact composition), `encodeApng` (frame-optimized, lossless in the rendered result), and first-class handling in `optimizeImage` / `shrinkImage` — an animated PNG is treated exactly like an animated GIF, and `format: "png"` on an animated GIF produces an APNG. `decodePng` stays first-frame-only (the spec fallback).

## Why the skip was wrong

The 08-16 reasoning measured _CDN traffic share_ (< 0.1% of sites, Giphy/Tenor don’t serve it). The right question for a library that shrinks what people upload is _where do animated stickers with alpha go_, and there APNG is the native format:

- Discord animated stickers: APNG, 500 KB cap; GIF explicitly not wanted.
- iMessage sticker packs: APNG.
- Slack and Discord custom emoji: APNG accepted.
- Signal animated stickers: APNG.
- Browsers: ~96% (Chrome 59+, Firefox 3+, Safari 8+, Edge).

It also degrades gracefully — a non-APNG viewer shows the first frame instead of a broken image — which none of GIF/WebP/AVIF animation does. Once the GIF encoder had a dirty-rect/frame-dedup planner, APNG became a chunk wrapper around the PNG codec plus that planner: cheap.

Sources: Discord sticker guides (2026), Apple sticker pack docs, caniuse `apng`, ezgif “alternatives to animated GIF”.

## Shape

- `decodeApng(bytes, { maxPixels }) → { width, height, frames, delays (ms), loop }` — same shape as `decodeGif`. `acTL`/`fcTL`/`fdAT` with sequence-number validation; `dispose_op` 0/1/2 and `blend_op` 0/1 composited the way browsers do; `fcTL` rectangles must lie inside the canvas; `maxPixels` applies to the canvas and every frame rectangle.
- `encodeApng(frames, { loop, effort })` — canvas = first frame; all frames must match. First frame lives in `IDAT` (so it is a valid still for non-APNG viewers). Per frame: diff against the decoder’s canvas state, crop to the dirty rectangle, `blend_op` over with unchanged pixels transparent when the patch is expressible that way, `dispose_op` chosen to minimize the next rectangle, identical consecutive frames merged. One IHDR color type for the whole animation (smallest exact kind across all frame rectangles).
- The 8-bit `PixelBuffer` contract holds; 16-bit APNG decodes to 8-bit like still PNG.

## Not doing

- Palette (color type 3) animations unless it falls out of the color-type picker for free.
- Dropping `default image` semantics: if `IDAT` is not part of the animation (no `fcTL` before it), we honor that and skip it in playback, as browsers do.

## Review round (2026-08)

- `maxPixels` bounds `canvas × acTL.num_frames` before compositing; `num_frames` 0 or a count mismatch throws; `fcTL` rects must lie inside the canvas.
- `encodeApng({ loop })`: `undefined` → `num_plays = 1` (play once), `0` → forever, `n` → n. Matches `encodeGif`.
- `eXIf` orientation is applied to every frame like `decodePng`.
