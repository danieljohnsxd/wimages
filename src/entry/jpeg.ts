/** `wimgs/jpeg` — JPEG codec only. */
export { createPixelBuffer, type PixelBuffer } from "../pixels.ts";
export { DEFAULT_MAX_PIXELS, type DecodeLimits } from "../limits.ts";
export { decodeJpeg, type JpegDecodeOptions } from "../jpeg/decode.ts";
export { encodeJpeg, type JpegEncodeOptions } from "../jpeg/encode.ts";
export { withExifOrientation, exifOrientation, type ImageMetadata } from "../metadata.ts";
export { readJpegMetadata as readImageMetadata } from "../jpeg/metadata.ts";
export { transcodeJpeg, type JpegTranscodeOptions } from "../jpeg/transcode.ts";
