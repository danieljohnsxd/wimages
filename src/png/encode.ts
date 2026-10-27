import { zlibDeflate } from "../deflate/zlib.ts";
import type { ImageMetadata } from "../metadata.ts";
import type { PixelBuffer } from "../pixels.ts";
import { concatBytes, createChunk, PNG_SIGNATURE, writeUint32BE } from "./chunk.ts";
import { analyzeRgba, type ColorAnalysis, type PngColorKind } from "./color.ts";
import { pngRangeError } from "./error.ts";
import { filterImage } from "./filter.ts";
import { pngMetadataChunks } from "./metadata.ts";
import { packScanlines } from "./pack.ts";
import { quantizeToPalette } from "./quantize.ts";

export type PngEncodeOptions = {
  /**
   * `"fast"` (default): greedy LZ77, sub filter — the upload/encode default.
   * `"strong"`: lazy LZ77 + deep chains, adaptive per-row filter; slower, fewer bytes.
   * Product-layer `optimizeImage` asks for `"strong"` explicitly.
   */
  readonly effort?: "fast" | "strong";
  /** Default "auto". */
  readonly colorType?: PngColorKind | "auto";
  /** When set (2–256), remap RGBA to at most this many colors via median-cut. */
  readonly maxColors?: number;
  /** EXIF / ICC / XMP as eXIf / iCCP / iTXt, written after IHDR (iCCP before PLTE). Default none. */
  readonly metadata?: ImageMetadata;
};

export const COLOR_TYPE_CODE: Record<PngColorKind, number> = {
  gray: 0,
  rgb: 2,
  palette: 3,
  "gray-alpha": 4,
  rgba: 6,
};

export type PngPayload = {
  readonly compressed: Uint8Array;
  readonly bitDepth: 1 | 2 | 4 | 8;
  readonly colorType: number;
  readonly plte: Uint8Array | undefined;
  readonly trns: Uint8Array | undefined;
};

const COLOR_TYPES = new Set<PngColorKind | "auto">([
  "auto",
  "gray",
  "gray-alpha",
  "rgb",
  "rgba",
  "palette",
]);

const EFFORTS = new Set<NonNullable<PngEncodeOptions["effort"]>>(["fast", "strong"]);

export function resolvePngEffort(
  effort: PngEncodeOptions["effort"],
): NonNullable<PngEncodeOptions["effort"]> {
  const value = effort ?? "fast";
  if (!EFFORTS.has(value)) {
    throw pngRangeError('effort must be "fast" or "strong"');
  }
  return value;
}

function resolveColorType(colorType: PngEncodeOptions["colorType"]): PngColorKind | "auto" {
  const value = colorType ?? "auto";
  if (!COLOR_TYPES.has(value)) {
    throw pngRangeError(
      'colorType must be "auto", "gray", "gray-alpha", "rgb", "rgba", or "palette"',
    );
  }
  return value;
}

function resolveMaxColors(maxColors: number | undefined): number | undefined {
  if (maxColors === undefined) {
    return undefined;
  }
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) {
    throw pngRangeError("maxColors must be an integer from 2 to 256");
  }
  return maxColors;
}

function effortConfig(effort: NonNullable<PngEncodeOptions["effort"]>): {
  readonly level: number;
  readonly filter: "sub" | "adaptive";
} {
  if (effort === "strong") {
    return { level: 9, filter: "adaptive" };
  }
  // Level 2 (greedy, short chain): same class as 3, faster, and not larger on photo-like content.
  return { level: 2, filter: "sub" };
}

/** Pack + filter + zlib one image. Shared by still PNG and APNG frame rectangles. */
export function encodePngPayload(
  data: Uint8Array,
  width: number,
  height: number,
  analysis: ColorAnalysis,
  effort: NonNullable<PngEncodeOptions["effort"]>,
): PngPayload {
  const { level, filter } = effortConfig(effort);
  const packed = packScanlines(data, width, height, analysis);
  const filtered = filterImage(packed.lines, packed.bytesPerPixel, filter);
  const compressed = zlibDeflate(filtered, level);
  return {
    compressed,
    bitDepth: analysis.bitDepth,
    colorType: COLOR_TYPE_CODE[analysis.kind],
    plte: packed.plte,
    trns: packed.trns,
  };
}

export function buildIhdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return ihdr;
}

/** PNG encode: RGBA pixels in, PNG bytes out. Optional `maxColors` uses palette quantization. */
export function encodePng(image: PixelBuffer, options?: PngEncodeOptions): Uint8Array {
  const effort = resolvePngEffort(options?.effort);
  const colorType = resolveColorType(options?.colorType);
  const maxColors = resolveMaxColors(options?.maxColors);

  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw pngRangeError("width and height must be positive integers");
  }
  if (data.length !== width * height * 4) {
    throw pngRangeError("RGBA data length must equal width * height * 4");
  }

  let pixels = data;
  let analysis: ColorAnalysis;
  if (maxColors !== undefined) {
    const quantized = quantizeToPalette(data, width, height, maxColors);
    pixels = quantized.data;
    if (colorType === "auto" || colorType === "palette") {
      analysis = quantized.analysis;
    } else {
      analysis = analyzeRgba(quantized.data, width, height, colorType);
    }
  } else {
    analysis = analyzeRgba(data, width, height, colorType);
  }
  const payload = encodePngPayload(pixels, width, height, analysis, effort);

  const parts: Uint8Array[] = [
    PNG_SIGNATURE,
    createChunk("IHDR", buildIhdr(width, height, payload.bitDepth, payload.colorType)),
    ...pngMetadataChunks(options?.metadata),
  ];
  if (payload.plte !== undefined) {
    parts.push(createChunk("PLTE", payload.plte));
  }
  if (payload.trns !== undefined) {
    parts.push(createChunk("tRNS", payload.trns));
  }
  parts.push(createChunk("IDAT", payload.compressed));
  parts.push(createChunk("IEND", new Uint8Array(0)));
  return concatBytes(parts);
}
