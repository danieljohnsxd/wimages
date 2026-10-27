/**
 * wimgs — pure TypeScript PNG / JPEG / GIF codecs and a photo-upload shrinker (ES2022 ESM).
 *
 * Host-neutral: typed arrays only. No Node builtins, no canvas, no WASM.
 */

// Product entry points
export {
  decodeImage,
  optimizeImage,
  readImageMetadata,
  shrinkImage,
  sniffImageFormat,
  type ImageFormat,
  type OptimizeOptions,
  type OptimizeResult,
  type ShrinkOptions,
  type ShrinkResult,
} from "./image.ts";
export { fitSize, resize, type ResizeOptions } from "./resize.ts";
export { exifOrientation, withExifOrientation, type ImageMetadata } from "./metadata.ts";

// Pixels + guards
export { createPixelBuffer, type PixelBuffer } from "./pixels.ts";
export { DEFAULT_MAX_PIXELS, type DecodeLimits } from "./limits.ts";

// Codecs
export { decodePng } from "./png/decode.ts";
export { encodePng, type PngEncodeOptions } from "./png/encode.ts";
export type { PngColorKind } from "./png/color.ts";
export { quantizeToPalette } from "./png/quantize.ts";
export {
  decodeApng,
  encodeApng,
  isAnimatedPng,
  type ApngDecodeResult,
  type ApngEncodeOptions,
  type ApngFrame,
} from "./png/apng.ts";
export { decodeJpeg, type JpegDecodeOptions } from "./jpeg/decode.ts";
export { encodeJpeg, type JpegEncodeOptions } from "./jpeg/encode.ts";
export { transcodeJpeg, type JpegTranscodeOptions } from "./jpeg/transcode.ts";
export { decodeGif, type GifDecodeResult } from "./gif/decode.ts";
export { encodeGif, type GifEncodeOptions, type GifFrame } from "./gif/encode.ts";
export { optimizeGif } from "./gif/optimize.ts";
