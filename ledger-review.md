# Review round — five lenses, what they caught, what changed

Before calling the API done, five independent reviewers (grok-4.6, high effort) each took one lens over the whole repo: the **Hacker News skeptic** (defaults, naming, README truth), **hostile input** (bombs, budgets, unbounded loops), **edge cases** (the product-layer state machine), **test suite** (tautologies, coverage), and a **differential oracle** (our codecs vs. libjpeg-turbo, ImageIO, `node:zlib` on thousands of generated images). Five fix agents then worked the findings by file ownership; the maintainer merged, re-ran the oracles, and wrote this.

## Would have been the HN thread

| Finding                                                                                                                                                                                                      | Lens          | Fix                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deflate emitted **incomplete Huffman codes** (~0.35% of streams, incl. a 16×16 RGBA noise PNG). Our inflater accepted them; `node:zlib` and ImageIO refused the file. Every internal round-trip test passed. | oracle        | `enforceMaxBits` replaced with zlib’s overflow-repair construction; Kraft sum is asserted in tests; every IDAT the suite produces is inflated by `node:zlib`. |
| `transcodeJpeg` added a JFIF header to Adobe-RGB JPEGs → `optimizeImage` returned a smaller file with **wrong colors**, `jpegtran` did not.                                                                  | oracle        | JFIF only for YCbCr; Adobe transform 0 leaves APP0 out.                                                                                                       |
| A 5.8 KB GIF with 250 tiny frames on a 512² canvas decoded to **250 MB**; LZW output was uncapped.                                                                                                           | hostile       | `maxPixels` now bounds total frames × canvas, checked per frame before allocation; LZW capped at the frame rectangle.                                         |
| Default `maxPixels` of 16384² let a **23-byte JPEG header** reserve 768 MB before any scan.                                                                                                                  | hostile / HN  | Default 50 MP; JPEG checks the padded MCU grid and plane sizes before allocating; canvases allocate lazily.                                                   |
| `maxBytes` ladder aborted after one ×0.8 downscale (shared `SHRINK_MAX_ENCODES` counter).                                                                                                                    | edges / tests | Counter deleted; the ladder is walked per resolution down to the 256 px floor. The test that “verified” it had asserted a constant.                           |
| Play-once GIFs became **infinite loops** in `encodeGif`, `encodeApng`, and `shrinkImage`.                                                                                                                    | edges         | `loop: undefined` = play once everywhere; `0` = forever.                                                                                                      |
| Frame dropping **doubled** delays instead of summing pairs.                                                                                                                                                  | edges         | Summed; total duration preserved and tested.                                                                                                                  |

## API changes it forced

- `ShrinkResult.changed` → `lossless`. `changed` meant “bytes are not yours” on `optimizeImage` and “pixels differ” on `shrinkImage`; one word, two meanings.
- GIF delays are **ms** (were centiseconds under the same field name APNG used for ms).
- `encodePng` default `effort` is `"fast"`; `optimizeImage` still asks for `"strong"`.
- `format: "auto"` no longer turns a 257-color screenshot into a JPEG: >256-color PNG/GIF becomes JPEG only if fewer than 15% of pixels equal their left neighbor.
- `decodePng` applies `eXIf` orientation (the JPEG path already did); `decodeImage` reports `animated`.
- Unsupported formats are named in the error (WebP, HEIC, AVIF, BMP, TIFF; lossless / hierarchical / 12-bit JPEG). Every codec error is prefixed (`PNG:`, `JPEG:`, `GIF:`); product-layer errors carry the function name. Options are validated before work.
- `inflateRaw` accepted only streams that happened to have trailing bytes to peek into; it now zero-pads like zlib.

## Tests

203 → 286. Tautologies replaced (an LZW round-trip that checked only length, a ladder test asserting a constant, a “djpeg-verified progressive” test decoding a baseline stream). Added: `node:zlib` differential over ~185 inputs × 10 levels in both directions; Kraft assertions on adversarial frequency sets; independently written Adam7 / Paeth / 16-bit / palette+tRNS PNGs; IHDR-vs-ancillary CRC; LZW at every code size 2–8 on the EOI-after-width-bump edge; interlace, disposal 3, out-of-screen rects, the frame bomb under small and large budgets; Adobe-RGB transcode; padded-MCU budget; ICC chunks out of order; subpath export names from `dist/`.

## Verified after merge

- 168 `encodePng` outputs (6 sizes × 2 efforts × 4 contents × 4 color types): 0 rejected by `node:zlib`, 0 by ImageIO (`sips`).
- JPEG: `transcodeJpeg` pixel-identical to source under `djpeg`, byte-identical size to `jpegtran -optimize`; `encodeJpeg` q80 vs `djpeg` MAE 0.02.
- GIF / APNG: encode → `sips` → compare: 0 mismatched samples; animation round-trips frame-exact.
- Speed: unchanged within noise (A/B in one process against the pre-review build; deflate ~3% slower for the complete-code repair).
