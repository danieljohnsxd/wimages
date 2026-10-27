---
name: image-uploads
description: Shrink, optimize, or pick the format for user-uploaded images (JPEG, PNG, GIF, APNG) with the pure-TypeScript `wimgs` package — no native deps, runs in Workers, Convex, Deno, browsers. Load when handling image uploads, resizing photos to a byte/size budget, stripping EXIF/GPS, keeping GIFs animated, or deciding JPEG vs PNG vs GIF vs APNG.
---

# image-uploads (wimgs)

## When to use / when not to

- Use for an upload path where native libraries are unavailable or unwanted: Cloudflare Workers, Convex actions, Deno Deploy, Web Workers, edge functions.
- Use `sharp` (libvips) instead on a normal Node server with volume: 5–10× faster, more formats.
- Not for WebP / AVIF / HEIC output, crops, sprites, or color conversion. WebP/AVIF/HEIC/BMP/TIFF input throws a named error.
- Not for non-image bytes: use the sibling `wgzip` (gzip/deflate) or `wzstd` (zstd). Images are already compressed.

## Happy path

```ts
import { shrinkImage, optimizeImage } from "wimgs";

// Untrusted upload → ≤ 2048 px, ≤ 1 MiB, upright, EXIF/GPS gone, ICC kept, animation kept.
const out = shrinkImage(bytes, { maxSide: 2048, maxBytes: 1 << 20, maxPixels: 16_000_000 });
// out.bytes, out.format ("jpeg" | "png" | "gif"), out.width, out.height, out.animated

// Archive: pixel-identical, smaller or same size, private metadata stripped.
const { bytes: archived } = optimizeImage(bytes);
```

`maxPixels` is the decode budget (default 50,331,648 ≈ 50 MP, every animation frame counts). Lower it on 128 MB isolates (Cloudflare Workers: ~16 MP).

## Which format?

Leave `format: "auto"` unless you have a reason; it applies this table.

| Content                                | Format                                              |
| -------------------------------------- | --------------------------------------------------- |
| Photo (many colors, opaque)            | JPEG                                                |
| Screenshot, UI, diagram, logo, text    | PNG                                                 |
| Any transparency                       | PNG                                                 |
| Animation, meme, reaction GIF          | GIF — stays animated (never a video, never a still) |
| Animated sticker/emoji with real alpha | APNG: `shrinkImage(gif, { format: "png" })`         |
| "Smaller, change nothing"              | `optimizeImage` (same format, identical pixels)     |

WebP/AVIF/HEIC are never output. iPhone HEIC arrives as JPEG when the `<input type="file">` accepts `image/jpeg`; do not try to decode HEIC server-side with this package.

## Rules

- Call `shrinkImage` on the raw upload bytes; do not decode → resize → encode yourself (you lose orientation, ICC, animation, and the byte ladder).
- Keep `keepMetadata` at its default `false` for anything user-facing: it strips EXIF (GPS, device, time), XMP and text, keeps the ICC profile and orientation. `true` keeps GPS.
- `shrinkImage` output is always new bytes; `optimizeImage` may return the input object when there was nothing to improve or strip (`changed: false`).
- Do not force `format: "jpeg"` on screenshots or alpha images (blur, white background) or on animations (first frame only).
- Everything is synchronous and CPU-bound (≈ 1–3 s for a 12 MP photo): run it in a Worker / isolate, not on a UI thread.
- Validate type by bytes with `sniffImageFormat(bytes)`, not by file extension or MIME header.
- There are no compression levels: PNG effort is `"fast" | "strong"`, JPEG quality is `"small" | "balanced" | "high"` (or the IJG 1–100 number). The product verbs pick these for you.

## Errors

All throw synchronously; catch and reject the upload.

- `Error("shrinkImage: cannot fit WxH within maxBytes (N)")` — budget unreachable at the 256 px floor. Raise `maxBytes`.
- `Error("… exceeds maxPixels …")` — header larger than the budget; thrown before allocating.
- `Error("shrinkImage: HEIC is not supported")` (prefix is the function called; also WebP, AVIF, BMP, TIFF, `unknown image format`) — reject or convert client-side.
- `Error("JPEG: …" | "PNG: …" | "GIF: …")` — corrupt or unsupported variant (e.g. `JPEG: more than 100 scans`, arithmetic/12-bit JPEG).
- `RangeError("shrinkImage: …")` — bad option value (programming error).

## Why

See `references/context.md`: platform facts behind the format table (Discord/iMessage/Slack/Signal APNG), why ICC is kept, why there are presets not levels, and the safety limits.
