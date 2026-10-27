/**
 * Product entry: sniff, decode, lossless-optimize, and shrink to an upload-sized
 * JPEG, PNG, or GIF.
 *
 * Defaults match an upload path: upright pixels, alpha composited on white,
 * JPEG for photos, PNG for graphics/alpha, animations stay animated, no metadata.
 */

import { decodeGif, type GifDecodeResult } from "./gif/decode.ts";
import { encodeGif, type GifEncodeOptions, type GifFrame } from "./gif/encode.ts";
import { rewriteGif, stripGifMetadata } from "./gif/optimize.ts";
import { decodeJpeg } from "./jpeg/decode.ts";
import type { JpegEncodeOptions } from "./jpeg/encode.ts";
import { encodeJpeg } from "./jpeg/encode.ts";
import { applyOrientation, buildExifOrientationPayload } from "./jpeg/exif.ts";
import { readJpegMetadata, stripJpegMetadata } from "./jpeg/metadata.ts";
import { transcodeJpeg, type JpegTranscodeOptions } from "./jpeg/transcode.ts";
import { checkDimensions, DEFAULT_MAX_PIXELS, type DecodeLimits } from "./limits.ts";
import { exifOrientation, withExifOrientation, type ImageMetadata } from "./metadata.ts";
import type { PixelBuffer } from "./pixels.ts";
import {
  concatBytes,
  createChunk,
  parsePngChunks,
  PNG_SIGNATURE,
  readUint32BE,
} from "./png/chunk.ts";
import { rgbaKey } from "./png/color.ts";
import { quantizeToPalette } from "./png/quantize.ts";
import { decodePng, type PngDecodeOptions } from "./png/decode.ts";
import { encodePng, type PngEncodeOptions } from "./png/encode.ts";
import { decodeApng, encodeApng, isAnimatedPng, type ApngFrame } from "./png/apng.ts";
import { pngMetadataChunks, readPngMetadataFields, stripPngMetadata } from "./png/metadata.ts";
import { fitSize, resize } from "./resize.ts";

export type ImageFormat = "png" | "jpeg" | "gif";

export type ShrinkFormat = "auto" | "keep" | "jpeg" | "png" | "gif";

type OutputFormat = "jpeg" | "png" | "gif";

export type OptimizeOptions = DecodeLimits & {
  /** JPEG only: emit progressive. Default false. */
  readonly progressive?: boolean;
  /**
   * Default false: EXIF, XMP and text/comment metadata are stripped; the ICC
   * profile is kept (it defines the colors), and JPEG/PNG keep a one-tag
   * orientation EXIF/eXIf so the file displays upright. true: everything is
   * carried through unchanged.
   */
  readonly keepMetadata?: boolean;
};

export type OptimizeResult = {
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
  /** True when the output is a multi-frame GIF or APNG. */
  readonly animated: boolean;
  /**
   * false means `bytes` is the caller's original, untouched (with
   * `keepMetadata: false` that only happens when it had no metadata to strip).
   * true means new bytes with identical pixels: a smaller rewrite, or the
   * original with its private metadata removed.
   */
  readonly changed: boolean;
};

export type ShrinkOptions = DecodeLimits & {
  /** Longest side after shrinking. Default 2048. Never upscales. */
  readonly maxSide?: number;
  /** Hard ceiling on output bytes. Default 1 MiB (1_048_576). Throws if it cannot be met at the floor. */
  readonly maxBytes?: number;
  /**
   * Default "auto": alpha or ≤256 colors → PNG; animations keep their container;
   * JPEG stays JPEG. A PNG/GIF with >256 colors becomes JPEG only when it looks
   * photographic (fraction of pixels equal to their left neighbor < 0.15).
   * "keep": same container as the input. "jpeg" / "png" / "gif" force
   * (an animation forced to JPEG is its first frame; forced to PNG is an APNG).
   */
  readonly format?: ShrinkFormat;
  /** JPEG starting point. Default "balanced". */
  readonly quality?: JpegEncodeOptions["quality"];
  /**
   * Default false: EXIF and XMP are stripped and the ICC profile is kept
   * (JPEG/PNG keep a one-tag orientation EXIF on the lossless path so it
   * displays upright). true: carried through. On the lossy path the EXIF
   * orientation tag is rewritten to 1 because rotation is baked into the pixels.
   */
  readonly keepMetadata?: boolean;
};

export type ShrinkResult = {
  readonly bytes: Uint8Array;
  readonly format: OutputFormat;
  readonly width: number;
  readonly height: number;
  /** True when the output is a multi-frame GIF or APNG. */
  readonly animated: boolean;
  /**
   * true when the output pixels are identical to the input (the lossless rewrite
   * path). Bytes are always freshly produced (never the caller's original).
   */
  readonly lossless: boolean;
};

/** Default longest side for `shrinkImage`. */
export const DEFAULT_MAX_SIDE = 2048;
/** Default output byte ceiling (1 MiB). */
export const DEFAULT_MAX_BYTES = 1_048_576;
/**
 * Numeric JPEG qualities tried after the starting quality when hunting `maxBytes`.
 * Starting quality itself is encoded first and not repeated. Each resolution walks
 * this ladder once; the long side then drops ×0.8 and the ladder repeats, down to
 * `SHRINK_MIN_SIDE`. Bound: at most `jpegQualityAttempts.length × downscale steps`
 * JPEG encodes (two PNG encodes, or `GIF_COLOR_LADDER.length` GIF encodes, per
 * resolution; animations add one extra encode after dropping every other frame).
 */
export const JPEG_QUALITY_LADDER = [80, 72, 65, 58, 50, 42, 35] as const;
/** Long-side floor: a further ×0.8 step that would go below this throws. */
export const SHRINK_MIN_SIDE = 256;
const DOWNSCALE = 0.8;
const GIF_COLOR_LADDER = [256, 128, 64] as const;
const GRAPHICS_FLATNESS = 0.15;
const FLATNESS_SAMPLE_CAP = 2_000_000;
const BROWSER_MIN_DELAY_MS = 10;
const BROWSER_DEFAULT_DELAY_MS = 100;
/** GIF GCE delay field is 16-bit centiseconds, as milliseconds. */
const MAX_GIF_DELAY_MS = 655350;
const MAX_APNG_DELAY_MS = 65535;

const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const;
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const;
const IHDR = [0x49, 0x48, 0x44, 0x52] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;
const FTYP = [0x66, 0x74, 0x79, 0x70] as const;

const SHRINK_FORMATS = new Set<ShrinkFormat>(["auto", "keep", "jpeg", "png", "gif"]);

type Animation = {
  readonly format: "gif" | "png";
  /** Display-order frames (EXIF orientation applied). */
  readonly frames: PixelBuffer[];
  /** File-order frames (orientation not applied). Same as `frames` for GIF. */
  readonly fileFrames: PixelBuffer[];
  readonly delays: number[];
  readonly loop: number | undefined;
};

type ShrinkContext = {
  readonly formatOpt: ShrinkFormat;
  readonly quality: NonNullable<JpegEncodeOptions["quality"]>;
  readonly maxSide: number;
  readonly maxBytes: number;
  readonly maxPixels: number | undefined;
  readonly metadata: ImageMetadata | undefined;
  readonly orientation: number;
  readonly skipLossless: boolean;
};

export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "png";
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xff && b1 === 0xd8) {
    return "jpeg";
  }
  if (startsWith(bytes, GIF87A) || startsWith(bytes, GIF89A)) {
    return "gif";
  }
  return null;
}

/**
 * Decode PNG / JPEG / GIF into packed RGBA. GIF uses the first frame; APNG uses
 * the first frame (`decodePng`). EXIF / eXIf orientation is applied (upright
 * pixels). `animated` is true for multi-frame GIF / APNG so callers know they
 * received frame 1 of a longer sequence.
 */
export function decodeImage(
  bytes: Uint8Array,
  options?: DecodeLimits,
): { image: PixelBuffer; format: ImageFormat; animated: boolean } {
  validateDecodeLimits("decodeImage", options);
  const format = requireFormat(bytes, "decodeImage");
  if (format === "png") {
    return {
      image: decodePng(bytes, decodeOpts(options)),
      format,
      animated: isAnimatedPng(bytes),
    };
  }
  if (format === "jpeg") {
    return { image: decodeJpeg(bytes, decodeOpts(options)), format, animated: false };
  }
  const gif = decodeGif(bytes, decodeOpts(options));
  const frame = gif.frames[0];
  if (frame === undefined) {
    throw namedError("decodeImage", "GIF has no frames");
  }
  return { image: frame, format, animated: gif.frames.length > 1 };
}

/**
 * Lossless. Identical pixels, fewer bytes, private metadata stripped (ICC kept;
 * orientation preserved as a JPEG EXIF / PNG eXIf tag). When the rewrite cannot
 * beat the input — including 16-bit PNG, which would not survive an 8-bit
 * re-encode — the input comes back with only its metadata segments removed, or
 * untouched (`changed: false`) when there was nothing to remove.
 */
export function optimizeImage(bytes: Uint8Array, options?: OptimizeOptions): OptimizeResult {
  validateDecodeLimits("optimizeImage", options);
  validateKeepMetadata("optimizeImage", options?.keepMetadata);
  const format = requireFormat(bytes, "optimizeImage");
  const keepMetadata = options?.keepMetadata === true;
  const limits = decodeOpts(options);
  const rawMeta = readMetadata(bytes, limits, keepMetadata);
  const metadata = carriedMetadata(rawMeta, keepMetadata);
  const orientation = exifOrientation(rawMeta.exif);
  const finish = (candidate: Uint8Array, out: ImageFormat, animated: boolean): OptimizeResult =>
    finishOptimize(bytes, candidate, out, animated, keepMetadata, orientation);

  if (format === "jpeg") {
    return finish(transcodeJpeg(bytes, jpegTranscodeOptions(options, metadata)), "jpeg", false);
  }

  if (format === "gif") {
    const out = finish(rewriteGif(bytes, limits), "gif", false);
    return {
      bytes: out.bytes,
      format: "gif",
      animated: gifImageCount(out.bytes) > 1,
      changed: out.changed,
    };
  }

  const header = peekPngIhdr(bytes);
  if (header !== undefined) {
    checkDimensions("PNG", header.width, header.height, options?.maxPixels);
    if (header.bitDepth === 16) {
      // An 8-bit re-encode would not be lossless; only metadata can go.
      return finish(bytes, "png", isAnimatedPng(bytes));
    }
  }

  const pngMeta = withOrientationTag(metadata, orientation);
  const pngIgnore = pngIgnoreOrientation(options);

  if (isAnimatedPng(bytes)) {
    const decoded = decodeApng(bytes, pngIgnore);
    const encoded = writeApng(decoded.frames, decoded.delays, decoded.loop, pngMeta);
    return finish(encoded, "png", decoded.frames.length > 1);
  }

  const image = decodePng(bytes, pngIgnore);
  return finish(encodePng(image, pngEncodeOptions(pngMeta)), "png", false);
}

/**
 * Resize (never upscale) and re-encode so the long side is at most `maxSide`
 * and the payload is at most `maxBytes`. Output bytes are always freshly produced.
 * An already-fitting image of the same output format takes the lossless path
 * (`lossless: true` means pixels are identical). JPEG quality walks
 * `JPEG_QUALITY_LADDER` once per resolution; the long side then drops ×0.8 down
 * to `SHRINK_MIN_SIDE`. Animations drop colors, then frames, then resolution.
 */
export function shrinkImage(bytes: Uint8Array, options?: ShrinkOptions): ShrinkResult {
  validateDecodeLimits("shrinkImage", options);
  validateKeepMetadata("shrinkImage", options?.keepMetadata);
  const maxSide = options?.maxSide ?? DEFAULT_MAX_SIDE;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  requirePositiveInt("shrinkImage", maxSide, "maxSide");
  requirePositiveInt("shrinkImage", maxBytes, "maxBytes");

  const formatOpt = options?.format ?? "auto";
  if (!SHRINK_FORMATS.has(formatOpt)) {
    throw namedRangeError("shrinkImage", 'format must be "auto", "keep", "jpeg", "png", or "gif"');
  }
  const quality = requireJpegQuality("shrinkImage", options?.quality);
  const keepMetadata = options?.keepMetadata === true;
  const rawMeta = readMetadata(bytes, decodeOpts(options), keepMetadata);
  const metadata = carriedMetadata(rawMeta, keepMetadata);
  const orientation = exifOrientation(rawMeta.exif);
  const inputFormat = requireFormat(bytes, "shrinkImage");

  const ctx: ShrinkContext = {
    formatOpt,
    quality,
    maxSide,
    maxBytes,
    maxPixels: options?.maxPixels,
    metadata,
    orientation,
    skipLossless: false,
  };

  if (inputFormat === "gif") {
    const decoded = decodeGif(bytes, decodeOpts(options));
    return shrinkDecoded(
      bytes,
      inputFormat,
      decodedToStill(decoded),
      animationFromGif(decoded),
      ctx,
    );
  }

  if (inputFormat === "png" && isAnimatedPng(bytes)) {
    const fileOrder = decodeApng(bytes, pngIgnoreOrientation(options));
    const still = displayFrame(fileOrder.frames[0], orientation, "APNG has no frames");
    return shrinkDecoded(bytes, inputFormat, still, animationFromApng(fileOrder, orientation), ctx);
  }

  if (inputFormat === "png") {
    const png16 = peekPngIhdr(bytes)?.bitDepth === 16;
    const fileOrder = decodePng(bytes, pngIgnoreOrientation(options));
    const still = applyOrientation(fileOrder, orientation);
    return shrinkDecoded(bytes, inputFormat, still, undefined, {
      ...ctx,
      skipLossless: png16,
    });
  }

  const decoded = decodeImage(bytes, decodeOpts(options));
  return shrinkDecoded(bytes, decoded.format, decoded.image, undefined, ctx);
}

/**
 * EXIF / ICC / XMP as raw payloads. PNG and JPEG only; GIF and unknown bytes
 * yield `{}`. `maxPixels` is applied to the declared dimensions before the
 * JPEG marker walk / PNG chunk walk.
 */
export function readImageMetadata(bytes: Uint8Array, options?: DecodeLimits): ImageMetadata {
  validateDecodeLimits("readImageMetadata", options);
  return readMetadata(bytes, options, true);
}

function readMetadata(
  bytes: Uint8Array,
  options: DecodeLimits | undefined,
  includeXmp: boolean,
): ImageMetadata {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const header = peekPngIhdr(bytes);
    if (header !== undefined) {
      checkDimensions("PNG", header.width, header.height, options?.maxPixels);
    }
    return readPngMetadataFields(bytes, includeXmp);
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xff && b1 === 0xd8) {
    return readJpegMetadata(bytes, options?.maxPixels);
  }
  return {};
}

function shrinkDecoded(
  bytes: Uint8Array,
  inputFormat: ImageFormat,
  still: PixelBuffer,
  animation: Animation | undefined,
  ctx: ShrinkContext,
): ShrinkResult {
  const animated = animation !== undefined && animation.frames.length > 1;
  const outFormat = chooseOutputFormat(still, inputFormat, ctx.formatOpt, animated);
  const longSide = still.width > still.height ? still.width : still.height;
  const sameContainer = outFormat === inputFormat;
  const keepAnimation = animated && (outFormat === "gif" || outFormat === "png");

  if (
    !ctx.skipLossless &&
    longSide <= ctx.maxSide &&
    sameContainer &&
    (!animated || keepAnimation)
  ) {
    const rewritten =
      animation !== undefined &&
      animation.frames.length > 1 &&
      (outFormat === "gif" || outFormat === "png")
        ? rewriteAnimation(animation, outFormat, ctx.metadata, ctx.orientation)
        : rewriteStill(bytes, still, inputFormat, ctx.metadata, ctx.orientation, ctx.maxPixels);
    if (rewritten.length <= ctx.maxBytes) {
      return {
        bytes: rewritten,
        format: outFormat,
        width: still.width,
        height: still.height,
        animated,
        lossless: true,
      };
    }
  }

  if (keepAnimation) {
    return encodeAnimationToBudget(animation, outFormat, ctx);
  }

  const fitted = resize(still, { maxSide: ctx.maxSide });
  const encoded = encodeStillToBudget(
    fitted,
    outFormat,
    ctx.quality,
    ctx.maxBytes,
    bakeOrientation(ctx.metadata),
  );
  return {
    bytes: encoded.bytes,
    format: outFormat,
    width: encoded.width,
    height: encoded.height,
    animated: false,
    lossless: false,
  };
}

function chooseOutputFormat(
  image: PixelBuffer,
  inputFormat: ImageFormat,
  format: ShrinkFormat,
  animated: boolean,
): OutputFormat {
  if (format === "jpeg" || format === "png" || format === "gif") {
    return format;
  }
  if (format === "keep") {
    return inputFormat;
  }
  if (animated) {
    return inputFormat;
  }
  if (inputFormat === "jpeg") {
    return "jpeg";
  }
  if (prefersPng(image)) {
    return "png";
  }
  return "jpeg";
}

/**
 * Alpha or ≤256 unique colors → PNG. Otherwise the left-neighbor flatness test
 * (≥ 0.15 identical to the pixel on the left → graphics/screenshot → PNG;
 * else photo → JPEG).
 */
function prefersPng(image: PixelBuffer): boolean {
  const data = image.data;
  const seen = new Set<number>();
  let colorsExceeded = false;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 0;
    if (a !== 255) {
      return true;
    }
    if (!colorsExceeded) {
      seen.add(rgbaKey(r, g, b, a));
      if (seen.size > 256) {
        colorsExceeded = true;
      }
    }
  }
  if (!colorsExceeded) {
    return true;
  }
  return leftNeighborFlatness(data, image.width, image.height) >= GRAPHICS_FLATNESS;
}

function leftNeighborFlatness(data: Uint8Array, width: number, height: number): number {
  const pixelCount = width * height;
  const step = pixelCount > FLATNESS_SAMPLE_CAP ? Math.ceil(pixelCount / FLATNESS_SAMPLE_CAP) : 1;
  let equal = 0;
  let compared = 0;
  for (let p = 0; p < pixelCount; p += step) {
    const x = p % width;
    if (x === 0) {
      continue;
    }
    const i = p << 2;
    const left = i - 4;
    if (
      data[i] === data[left] &&
      data[i + 1] === data[left + 1] &&
      data[i + 2] === data[left + 2] &&
      data[i + 3] === data[left + 3]
    ) {
      equal += 1;
    }
    compared += 1;
  }
  if (compared === 0) {
    return 0;
  }
  return equal / compared;
}

function rewriteStill(
  bytes: Uint8Array,
  image: PixelBuffer,
  format: ImageFormat,
  metadata: ImageMetadata | undefined,
  orientation: number,
  maxPixels: number | undefined,
): Uint8Array {
  const limits = maxPixels === undefined ? undefined : { maxPixels };
  if (format === "jpeg") {
    return transcodeJpeg(bytes, jpegTranscodeOptions(limits, metadata));
  }
  if (format === "gif") {
    return encodeGif(image);
  }
  const fileOrder = decodePng(bytes, pngIgnoreOrientation(limits));
  return encodePng(fileOrder, pngEncodeOptions(withOrientationTag(metadata, orientation)));
}

function rewriteAnimation(
  animation: Animation,
  outFormat: "gif" | "png",
  metadata: ImageMetadata | undefined,
  orientation: number,
): Uint8Array {
  const delays = convertDelays(animation.format, outFormat, animation.delays);
  if (outFormat === "gif") {
    return writeGif(animation.frames, delays, animation.loop);
  }
  return writeApng(
    animation.fileFrames,
    delays,
    animation.loop,
    withOrientationTag(metadata, orientation),
  );
}

/**
 * Walk the format's quality/palette ladder once at the current size, then
 * downscale ×0.8 and repeat until `SHRINK_MIN_SIDE`. Bound: ladder length ×
 * downscale steps. No shared encode cap.
 */
function encodeStillToBudget(
  image: PixelBuffer,
  format: OutputFormat,
  quality: JpegEncodeOptions["quality"],
  maxBytes: number,
  metadata: ImageMetadata | undefined,
): { bytes: Uint8Array; width: number; height: number } {
  let current = image;
  const png: PngLadderState = { full: PNG_STRONG_BEST_RATIO, palette: PNG_STRONG_BEST_RATIO };

  for (;;) {
    const encoded = encodeStillAtSize(current, format, quality, maxBytes, metadata, png);
    if (encoded.length <= maxBytes) {
      return { bytes: encoded, width: current.width, height: current.height };
    }
    let next = nextDownscaleSide(current);
    if (next === undefined) {
      throw cannotFit(current, maxBytes);
    }
    if (format === "png") {
      next = skipHopelessSides(current, next, encoded.length, maxBytes);
    }
    current = resize(current, { maxSide: next });
  }
}

function encodeStillAtSize(
  image: PixelBuffer,
  format: OutputFormat,
  quality: JpegEncodeOptions["quality"],
  maxBytes: number,
  metadata: ImageMetadata | undefined,
  png: PngLadderState,
): Uint8Array {
  if (format === "jpeg") {
    const attempts = jpegQualityAttempts(quality);
    let last: Uint8Array | undefined;
    for (let i = 0; i < attempts.length; i++) {
      const q = attempts[i];
      if (q === undefined) {
        break;
      }
      last = encodeJpeg(image, jpegEncodeOptions(q, metadata));
      if (last.length <= maxBytes) {
        return last;
      }
    }
    return last ?? encodeJpeg(image, jpegEncodeOptions("balanced", metadata));
  }
  if (format === "png") {
    const full = encodePngToBudget(image, maxBytes, metadata, png, "full");
    if (full.length <= maxBytes) {
      return full;
    }
    const quantized = quantizeToPalette(image.data, image.width, image.height, 256);
    const indexed = { width: image.width, height: image.height, data: quantized.data };
    return encodePngToBudget(indexed, maxBytes, metadata, png, "palette");
  }
  let last: Uint8Array | undefined;
  for (let i = 0; i < GIF_COLOR_LADDER.length; i++) {
    const maxColors = GIF_COLOR_LADDER[i];
    if (maxColors === undefined) {
      break;
    }
    last = encodeGif(image, { maxColors, dither: "floyd-steinberg" });
    if (last.length <= maxBytes) {
      return last;
    }
  }
  return last ?? encodeGif(image, { maxColors: 64, dither: "floyd-steinberg" });
}

/**
 * `"strong"` / `"fast"` byte ratio assumed before it is measured: the best case
 * (strong is 15–60% smaller, `ledger-png.md`). Once one strong encode has run
 * at some size, the measured ratio for this image replaces it.
 */
const PNG_STRONG_BEST_RATIO = 0.4;

type PngLadderState = { full: number; palette: number };

/**
 * PNG at one size: a `"fast"` probe first, then `"strong"` only when the probe
 * says strong can fit (probe × strong/fast ratio ≤ maxBytes). A strong encode
 * is ~5× a fast one, and the ladder may visit a dozen sizes; probing keeps
 * strong to the one or two sizes where it decides the outcome. Returns the
 * smaller encode (over budget when nothing fits).
 */
function encodePngToBudget(
  image: PixelBuffer,
  maxBytes: number,
  metadata: ImageMetadata | undefined,
  state: PngLadderState,
  kind: "full" | "palette",
): Uint8Array {
  const fast = encodePng(image, { ...pngEncodeOptions(metadata), effort: "fast" });
  if (fast.length * state[kind] > maxBytes) {
    return fast;
  }
  const strong = encodePng(image, pngEncodeOptions(metadata));
  state[kind] = Math.min(1, strong.length / fast.length);
  return strong.length <= fast.length ? strong : fast;
}

function encodeAnimationToBudget(
  animation: Animation,
  format: "gif" | "png",
  ctx: ShrinkContext,
): ShrinkResult {
  let frames = resizeFrames(animation.frames, ctx.maxSide, ctx.maxPixels);
  let delays = convertDelays(animation.format, format, animation.delays);
  const loop = animation.loop;
  const meta = format === "png" ? bakeOrientation(ctx.metadata) : undefined;

  for (;;) {
    const first = frames[0];
    if (first === undefined) {
      throw namedError("shrinkImage", "animation has no frames");
    }

    const encoded = encodeAnimationAtSize(frames, delays, loop, format, ctx.maxBytes, meta);
    if (encoded.length <= ctx.maxBytes) {
      return animationResult(encoded, format, first);
    }

    if (frames.length > 2) {
      const dropped = dropEveryOther(frames, delays);
      frames = dropped.frames;
      delays = dropped.delays;
      const droppedOut = encodeAnimationAtSize(frames, delays, loop, format, ctx.maxBytes, meta);
      if (droppedOut.length <= ctx.maxBytes) {
        return animationResult(droppedOut, format, first);
      }
    }

    const next = nextDownscaleSide(first);
    if (next === undefined) {
      throw cannotFit(first, ctx.maxBytes);
    }
    frames = resizeFrames(frames, next, ctx.maxPixels);
  }
}

function encodeAnimationAtSize(
  frames: readonly PixelBuffer[],
  delays: readonly number[],
  loop: number | undefined,
  format: "gif" | "png",
  maxBytes: number,
  metadata: ImageMetadata | undefined,
): Uint8Array {
  if (format === "gif") {
    let last: Uint8Array | undefined;
    for (let i = 0; i < GIF_COLOR_LADDER.length; i++) {
      const maxColors = GIF_COLOR_LADDER[i];
      if (maxColors === undefined) {
        break;
      }
      last = writeGif(frames, delays, loop, { maxColors, dither: "floyd-steinberg" });
      if (last.length <= maxBytes) {
        return last;
      }
    }
    return last ?? writeGif(frames, delays, loop, { maxColors: 64, dither: "floyd-steinberg" });
  }
  return writeApng(frames, delays, loop, metadata);
}

function animationResult(
  bytes: Uint8Array,
  format: "gif" | "png",
  frame: PixelBuffer,
): ShrinkResult {
  return {
    bytes,
    format,
    width: frame.width,
    height: frame.height,
    animated: true,
    lossless: false,
  };
}

function writeGif(
  frames: readonly PixelBuffer[],
  delays: readonly number[],
  loop: number | undefined,
  extra?: { readonly maxColors?: number; readonly dither?: GifEncodeOptions["dither"] },
): Uint8Array {
  if (frames.length === 1) {
    const frame = frames[0];
    if (frame === undefined) {
      throw namedError("shrinkImage", "GIF has no image data");
    }
    return encodeGif(frame, gifEncodeOptions(loop, extra));
  }
  const list: GifFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    list.push({
      width: frame.width,
      height: frame.height,
      data: frame.data,
      delay: clampDelay(delays[i] ?? 0, MAX_GIF_DELAY_MS),
    });
  }
  return encodeGif(list, gifEncodeOptions(loop, extra, "local"));
}

function writeApng(
  frames: readonly PixelBuffer[],
  delays: readonly number[],
  loop: number | undefined,
  metadata: ImageMetadata | undefined,
): Uint8Array {
  const list: ApngFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    const image = frames[i];
    if (image === undefined) {
      continue;
    }
    list.push({ image, delay: clampDelay(delays[i] ?? 0, MAX_APNG_DELAY_MS) });
  }
  const encoded =
    loop === undefined
      ? encodeApng(list, { effort: "strong" })
      : encodeApng(list, { effort: "strong", loop });
  return withPngMetadata(encoded, metadata);
}

function withPngMetadata(png: Uint8Array, metadata: ImageMetadata | undefined): Uint8Array {
  const extra = pngMetadataChunks(metadata);
  if (extra.length === 0) {
    return png;
  }
  const chunks = parsePngChunks(png);
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) {
      continue;
    }
    parts.push(createChunk(chunk.type, chunk.data));
    if (chunk.type === "IHDR") {
      for (let j = 0; j < extra.length; j++) {
        const piece = extra[j];
        if (piece !== undefined) {
          parts.push(piece);
        }
      }
    }
  }
  return concatBytes(parts);
}

function animationFromGif(decoded: GifDecodeResult): Animation | undefined {
  if (decoded.frames.length <= 1) {
    return undefined;
  }
  return {
    format: "gif",
    frames: decoded.frames,
    fileFrames: decoded.frames,
    delays: decoded.delays,
    loop: decoded.loop,
  };
}

function animationFromApng(
  decoded: {
    readonly frames: PixelBuffer[];
    readonly delays: number[];
    readonly loop: number | undefined;
  },
  orientation: number,
): Animation {
  const display: PixelBuffer[] = [];
  for (let i = 0; i < decoded.frames.length; i++) {
    const frame = decoded.frames[i];
    if (frame === undefined) {
      continue;
    }
    display.push(applyOrientation(frame, orientation));
  }
  return {
    format: "png",
    frames: display,
    fileFrames: decoded.frames,
    delays: decoded.delays,
    loop: decoded.loop,
  };
}

function decodedToStill(decoded: GifDecodeResult): PixelBuffer {
  const frame = decoded.frames[0];
  if (frame === undefined) {
    throw namedError("shrinkImage", "GIF has no frames");
  }
  return frame;
}

function displayFrame(
  frame: PixelBuffer | undefined,
  orientation: number,
  missing: string,
): PixelBuffer {
  if (frame === undefined) {
    throw namedError("shrinkImage", missing);
  }
  return applyOrientation(frame, orientation);
}

/** Same-container delays pass through (ms). Cross-container: browser ≤10 ms → 100 ms. */
function convertDelays(
  source: "gif" | "png",
  dest: "gif" | "png",
  delays: readonly number[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < delays.length; i++) {
    const d = delays[i] ?? 0;
    if (source !== dest && d <= BROWSER_MIN_DELAY_MS) {
      out.push(BROWSER_DEFAULT_DELAY_MS);
    } else {
      out.push(d);
    }
  }
  return out;
}

function resizeFrames(
  frames: readonly PixelBuffer[],
  maxSide: number,
  maxPixels: number | undefined,
): PixelBuffer[] {
  const first = frames[0];
  if (first === undefined) {
    return [];
  }
  const fit = fitSize(first.width, first.height, maxSide);
  checkDimensions("resize", fit.width, fit.height, maxPixels ?? DEFAULT_MAX_PIXELS, frames.length);
  const out: PixelBuffer[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    out.push(resize(frame, { maxSide }));
  }
  return out;
}

function dropEveryOther(
  frames: readonly PixelBuffer[],
  delays: readonly number[],
): { frames: PixelBuffer[]; delays: number[] } {
  const nextFrames: PixelBuffer[] = [];
  const nextDelays: number[] = [];
  for (let i = 0; i < frames.length; i += 2) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    nextFrames.push(frame);
    const kept = delays[i] ?? 0;
    const dropped = i + 1 < frames.length ? (delays[i + 1] ?? 0) : 0;
    nextDelays.push(clampDelay(kept + dropped, MAX_GIF_DELAY_MS));
  }
  if (nextFrames.length < 2) {
    return { frames: frames.slice(), delays: delays.slice() };
  }
  return { frames: nextFrames, delays: nextDelays };
}

function clampDelay(delay: number, max: number): number {
  if (delay < 0) {
    return 0;
  }
  if (delay > max) {
    return max;
  }
  return delay;
}

/**
 * PNG only: walk further down the ×0.8 ladder while even a proportional
 * shrink of the smallest encode at this size (bytes ∝ pixels) stays over
 * budget. Downscaled images are denser, so bytes per pixel only rise and
 * the estimate errs toward trying a size, never toward skipping one that
 * would fit. Each skipped size saves a quantize + two encodes.
 */
function skipHopelessSides(
  image: PixelBuffer,
  first: number,
  bytes: number,
  maxBytes: number,
): number {
  const long = image.width > image.height ? image.width : image.height;
  let side = first;
  for (;;) {
    const predicted = bytes * (side / long) * (side / long);
    const next = Math.max(1, Math.round(side * DOWNSCALE));
    if (predicted <= maxBytes || next < SHRINK_MIN_SIDE || next >= side) {
      return side;
    }
    side = next;
  }
}

function nextDownscaleSide(image: PixelBuffer): number | undefined {
  const long = image.width > image.height ? image.width : image.height;
  const next = Math.max(1, Math.round(long * DOWNSCALE));
  if (next < SHRINK_MIN_SIDE || next >= long) {
    return undefined;
  }
  return next;
}

function bakeOrientation(metadata: ImageMetadata | undefined): ImageMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const exif = metadata.exif;
  if (exif === undefined) {
    return metadata;
  }
  return { ...metadata, exif: withExifOrientation(exif, 1) };
}

/** TIFF payload of a one-tag orientation EXIF, or undefined for 1 / invalid. */
function orientationExif(orientation: number): Uint8Array | undefined {
  if (orientation < 2 || orientation > 8) {
    return undefined;
  }
  return buildExifOrientationPayload(orientation).subarray(6);
}

/** Adds a one-tag orientation EXIF when `metadata` carries no EXIF of its own. */
function withOrientationTag(
  metadata: ImageMetadata | undefined,
  orientation: number,
): ImageMetadata | undefined {
  const exif = orientationExif(orientation);
  if (exif === undefined || metadata?.exif !== undefined) {
    return metadata;
  }
  return { ...metadata, exif };
}

/**
 * What an output carries. `keepMetadata: true`: everything read. Default: the
 * ICC profile only — it is how the pixels are meant to look (Display P3 photos
 * and screenshots go dull without it) and says nothing about the user, unlike
 * EXIF (GPS, device, time), XMP, and text chunks.
 */
function carriedMetadata(metadata: ImageMetadata, keep: boolean): ImageMetadata | undefined {
  if (keep) {
    if (metadata.exif === undefined && metadata.icc === undefined && metadata.xmp === undefined) {
      return undefined;
    }
    return metadata;
  }
  return metadata.icc === undefined ? undefined : { icc: metadata.icc };
}

function jpegTranscodeOptions(
  options: { readonly progressive?: boolean; readonly maxPixels?: number } | undefined,
  metadata: ImageMetadata | undefined,
): JpegTranscodeOptions {
  return {
    ...(options?.progressive === true ? { progressive: true as const } : {}),
    ...(options?.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function jpegEncodeOptions(
  quality: NonNullable<JpegEncodeOptions["quality"]>,
  metadata: ImageMetadata | undefined,
): JpegEncodeOptions {
  if (metadata === undefined) {
    return { quality };
  }
  return { quality, metadata };
}

function pngEncodeOptions(
  metadata: ImageMetadata | undefined,
  maxColors?: number,
): PngEncodeOptions {
  if (maxColors !== undefined && metadata !== undefined) {
    return { effort: "strong", maxColors, metadata };
  }
  if (maxColors !== undefined) {
    return { effort: "strong", maxColors };
  }
  if (metadata !== undefined) {
    return { effort: "strong", metadata };
  }
  return { effort: "strong" };
}

function gifEncodeOptions(
  loop: number | undefined,
  extra: { readonly maxColors?: number; readonly dither?: GifEncodeOptions["dither"] } | undefined,
  palette?: GifEncodeOptions["palette"],
): GifEncodeOptions {
  return {
    ...(palette !== undefined ? { palette } : {}),
    ...(extra?.maxColors !== undefined ? { maxColors: extra.maxColors } : {}),
    ...(extra?.dither !== undefined ? { dither: extra.dither } : {}),
    ...(loop !== undefined ? { loop } : {}),
  };
}

/**
 * Smaller of the rewrite and the original. With `keepMetadata: false` the
 * original is never handed back with its EXIF / XMP / text intact: it is
 * stripped in place (no re-encode, entropy data copied as-is), and if that
 * fails the metadata-free rewrite is returned even though it is larger.
 */
function finishOptimize(
  original: Uint8Array,
  candidate: Uint8Array,
  format: ImageFormat,
  animated: boolean,
  keepMetadata: boolean,
  orientation: number,
): OptimizeResult {
  if (candidate !== original && candidate.length < original.length) {
    return { bytes: candidate, format, animated, changed: true };
  }
  if (keepMetadata) {
    return { bytes: original, format, animated, changed: false };
  }
  let stripped: Uint8Array;
  try {
    stripped = stripMetadata(original, format, orientation);
  } catch (error) {
    if (candidate === original) {
      throw error;
    }
    return { bytes: candidate, format, animated, changed: true };
  }
  if (candidate !== original && candidate.length < stripped.length) {
    return { bytes: candidate, format, animated, changed: true };
  }
  return { bytes: stripped, format, animated, changed: stripped !== original };
}

function stripMetadata(bytes: Uint8Array, format: ImageFormat, orientation: number): Uint8Array {
  if (format === "jpeg") {
    return stripJpegMetadata(bytes, orientation);
  }
  if (format === "png") {
    return stripPngMetadata(bytes, orientationExif(orientation));
  }
  return stripGifMetadata(bytes);
}

/**
 * IHDR width / height / bit depth without walking the rest of the file.
 * Bit depth 16 is the lossless early-out: re-encoding would drop to 8-bit.
 */
function peekPngIhdr(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number; readonly bitDepth: number } | undefined {
  if (bytes.length < 29 || !startsWith(bytes, PNG_SIGNATURE)) {
    return undefined;
  }
  if (
    bytes[12] !== IHDR[0] ||
    bytes[13] !== IHDR[1] ||
    bytes[14] !== IHDR[2] ||
    bytes[15] !== IHDR[3]
  ) {
    return undefined;
  }
  if (readUint32BE(bytes, 8) !== 13) {
    return undefined;
  }
  return {
    width: readUint32BE(bytes, 16),
    height: readUint32BE(bytes, 20),
    bitDepth: bytes[24] ?? 0,
  };
}

/** Exported for tests that assert the quality sequence actually encoded. */
export function jpegQualityAttempts(
  quality: JpegEncodeOptions["quality"],
): Array<NonNullable<JpegEncodeOptions["quality"]>> {
  const start = quality ?? "balanced";
  const startNum = numericJpegQuality(start);
  const attempts: Array<NonNullable<JpegEncodeOptions["quality"]>> = [start];
  for (let i = 0; i < JPEG_QUALITY_LADDER.length; i++) {
    const q = JPEG_QUALITY_LADDER[i];
    if (q !== undefined && q < startNum) {
      attempts.push(q);
    }
  }
  return attempts;
}

function numericJpegQuality(quality: JpegEncodeOptions["quality"]): number {
  if (quality === undefined || quality === "balanced") {
    return 80;
  }
  if (quality === "small") {
    return 65;
  }
  if (quality === "high") {
    return 90;
  }
  if (typeof quality === "number" && Number.isInteger(quality) && quality >= 1 && quality <= 100) {
    return quality;
  }
  throw new RangeError('quality must be "small", "balanced", "high", or an integer from 1 to 100');
}

function requireJpegQuality(
  fn: string,
  quality: JpegEncodeOptions["quality"],
): NonNullable<JpegEncodeOptions["quality"]> {
  try {
    numericJpegQuality(quality);
  } catch {
    throw namedRangeError(
      fn,
      'quality must be "small", "balanced", "high", or an integer from 1 to 100',
    );
  }
  return quality ?? "balanced";
}

function cannotFit(image: PixelBuffer, maxBytes: number): Error {
  return namedError(
    "shrinkImage",
    `cannot fit ${image.width}x${image.height} within maxBytes (${maxBytes})`,
  );
}

function requirePositiveInt(fn: string, value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw namedRangeError(fn, `${name} must be a positive integer`);
  }
}

function validateDecodeLimits(fn: string, options: DecodeLimits | undefined): void {
  if (options === undefined || options.maxPixels === undefined) {
    return;
  }
  if (!Number.isFinite(options.maxPixels) || options.maxPixels <= 0) {
    throw namedRangeError(fn, "maxPixels must be a positive number");
  }
}

/** `value` is `unknown`: untyped JS callers can pass anything. */
function validateKeepMetadata(fn: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw namedRangeError(fn, "keepMetadata must be a boolean");
  }
}

function requireFormat(bytes: Uint8Array, fn: string): ImageFormat {
  const format = sniffImageFormat(bytes);
  if (format !== null) {
    return format;
  }
  throw namedError(fn, unsupportedFormatMessage(bytes));
}

function unsupportedFormatMessage(bytes: Uint8Array): string {
  if (startsWith(bytes, RIFF) && bytes.length >= 12 && startsWithAt(bytes, 8, WEBP)) {
    return "WebP is not supported";
  }
  if (bytes.length >= 12 && startsWithAt(bytes, 4, FTYP)) {
    const brand = latin1(bytes, 8, 4);
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "mif1") {
      return "HEIC is not supported";
    }
    if (brand === "avif") {
      return "AVIF is not supported";
    }
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0x42 && b1 === 0x4d) {
    return "BMP is not supported";
  }
  const b2 = bytes[2];
  const b3 = bytes[3];
  if (
    (b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) ||
    (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a)
  ) {
    return "TIFF is not supported";
  }
  return "unknown image format";
}

function decodeOpts(options: DecodeLimits | undefined): DecodeLimits | undefined {
  if (options?.maxPixels === undefined) {
    return undefined;
  }
  return { maxPixels: options.maxPixels };
}

function pngIgnoreOrientation(options: DecodeLimits | undefined): PngDecodeOptions {
  if (options?.maxPixels !== undefined) {
    return { maxPixels: options.maxPixels, orientation: "ignore" };
  }
  return { orientation: "ignore" };
}

function gifImageCount(bytes: Uint8Array): number {
  if (bytes.length < 13) {
    return 0;
  }
  const packed = bytes[10] ?? 0;
  let pos = 13;
  if ((packed & 0x80) !== 0) {
    pos += 3 * (1 << ((packed & 7) + 1));
  }
  let count = 0;
  while (pos < bytes.length) {
    const marker = bytes[pos];
    if (marker === 0x3b) {
      break;
    }
    if (marker === 0x2c) {
      if (pos + 10 > bytes.length) {
        break;
      }
      const localPacked = bytes[pos + 9] ?? 0;
      pos += 10;
      if ((localPacked & 0x80) !== 0) {
        pos += 3 * (1 << ((localPacked & 7) + 1));
      }
      pos += 1;
      pos = skipSubBlocks(bytes, pos);
      count += 1;
      continue;
    }
    if (marker === 0x21) {
      pos += 2;
      pos = skipSubBlocks(bytes, pos);
      continue;
    }
    break;
  }
  return count;
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let pos = start;
  while (pos < bytes.length) {
    const n = bytes[pos];
    if (n === undefined) {
      return pos;
    }
    pos += 1;
    if (n === 0) {
      return pos;
    }
    pos += n;
  }
  return pos;
}

function namedError(fn: string, message: string): Error {
  return new Error(`${fn}: ${message}`);
}

function namedRangeError(fn: string, message: string): RangeError {
  return new RangeError(`${fn}: ${message}`);
}

function startsWith(bytes: Uint8Array, sig: ArrayLike<number>): boolean {
  return startsWithAt(bytes, 0, sig);
}

function startsWithAt(bytes: Uint8Array, offset: number, sig: ArrayLike<number>): boolean {
  if (offset + sig.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) {
      return false;
    }
  }
  return true;
}

function latin1(bytes: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return s;
}
