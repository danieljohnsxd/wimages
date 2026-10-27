/** `wimages/png` — PNG codec only. */
export { createPixelBuffer, type PixelBuffer } from "../pixels.ts";
export { DEFAULT_MAX_PIXELS, type DecodeLimits } from "../limits.ts";
export { decodePng } from "../png/decode.ts";
export { encodePng, type PngEncodeOptions } from "../png/encode.ts";
export type { PngColorKind } from "../png/color.ts";
export { quantizeToPalette } from "../png/quantize.ts";
export { withExifOrientation, exifOrientation, type ImageMetadata } from "../metadata.ts";
export { readPngMetadata as readImageMetadata } from "../png/metadata.ts";
export {
  decodeApng,
  encodeApng,
  isAnimatedPng,
  type ApngDecodeResult,
  type ApngEncodeOptions,
  type ApngFrame,
} from "../png/apng.ts";
