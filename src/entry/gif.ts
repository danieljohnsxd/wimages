/** `wimgs/gif` — GIF codec only. */
export { createPixelBuffer, type PixelBuffer } from "../pixels.ts";
export { DEFAULT_MAX_PIXELS, type DecodeLimits } from "../limits.ts";
export { decodeGif, type GifDecodeResult } from "../gif/decode.ts";
export { encodeGif, type GifEncodeOptions, type GifFrame } from "../gif/encode.ts";
export { quantizeToPalette } from "../png/quantize.ts";
export { optimizeGif } from "../gif/optimize.ts";
