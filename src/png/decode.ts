import { zlibInflate } from "../deflate/zlib.ts";
import { applyOrientation } from "../jpeg/exif.ts";
import { checkDimensions, DEFAULT_MAX_PIXELS, type DecodeLimits } from "../limits.ts";
import { exifOrientation } from "../metadata.ts";
import type { PixelBuffer } from "../pixels.ts";
import { concatBytes, parsePngChunks, readUint16BE, readUint32BE, type PngChunk } from "./chunk.ts";
import { pngError, pngRangeError } from "./error.ts";
import { unfilterImage } from "./filter.ts";

const ADAM7 = [
  { x0: 0, y0: 0, dx: 8, dy: 8 },
  { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 },
  { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 },
  { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 },
] as const;

export type PngDecodeOptions = DecodeLimits & {
  /** Default `"apply"`: rotate/flip RGBA using eXIf tag 0x0112. */
  readonly orientation?: "apply" | "ignore";
};

export type PngIhdrInfo = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
};

export type PngColorState = {
  readonly palette: Array<{ r: number; g: number; b: number; a: number }> | undefined;
  readonly grayKey: number | undefined;
  readonly rgbKey: readonly [number, number, number] | undefined;
};

function firstChunk(chunks: readonly PngChunk[], type: string): PngChunk | undefined {
  for (const chunk of chunks) {
    if (chunk.type === type) {
      return chunk;
    }
  }
  return undefined;
}

export function concatIdat(chunks: readonly PngChunk[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "IDAT") {
      parts.push(chunk.data);
    }
  }
  if (parts.length === 0) {
    throw pngError("no IDAT data");
  }
  return concatBytes(parts);
}

function channelCount(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw pngError(`unsupported color type ${colorType}`);
  }
}

function scaleSample(sample: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return sample;
  }
  if (bitDepth === 16) {
    return sample >> 8;
  }
  const max = (1 << bitDepth) - 1;
  return Math.floor((sample * 255) / max);
}

function sampleAt(row: Uint8Array, sampleIndex: number, bitDepth: number): number {
  if (bitDepth === 8) {
    const v = row[sampleIndex];
    if (v === undefined) {
      throw pngRangeError("unexpected end of scanline");
    }
    return v;
  }
  if (bitDepth === 16) {
    const hi = row[sampleIndex * 2];
    const lo = row[sampleIndex * 2 + 1];
    if (hi === undefined || lo === undefined) {
      throw pngRangeError("unexpected end of scanline");
    }
    return (hi << 8) | lo;
  }
  const bitOffset = sampleIndex * bitDepth;
  const byteIndex = bitOffset >> 3;
  const shift = 8 - bitDepth - (bitOffset & 7);
  const mask = (1 << bitDepth) - 1;
  const byte = row[byteIndex];
  if (byte === undefined) {
    throw pngRangeError("unexpected end of scanline");
  }
  return (byte >> shift) & mask;
}

function passExtent(size: number, offset: number, step: number): number {
  if (offset >= size) {
    return 0;
  }
  return Math.ceil((size - offset) / step);
}

function writePixel(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const o = (y * width + x) * 4;
  rgba[o] = r;
  rgba[o + 1] = g;
  rgba[o + 2] = b;
  rgba[o + 3] = a;
}

function unpackLine(
  row: Uint8Array,
  width: number,
  bitDepth: number,
  colorType: number,
  palette: Array<{ r: number; g: number; b: number; a: number }> | undefined,
  grayKey: number | undefined,
  rgbKey: readonly [number, number, number] | undefined,
  plot: (x: number, r: number, g: number, b: number, a: number) => void,
): void {
  for (let x = 0; x < width; x++) {
    if (colorType === 3) {
      if (palette === undefined) {
        throw pngError("palette PNG missing PLTE");
      }
      const index = sampleAt(row, x, bitDepth);
      const color = palette[index];
      if (color === undefined) {
        throw pngError("palette index out of range");
      }
      plot(x, color.r, color.g, color.b, color.a);
      continue;
    }
    const base = x * channelCount(colorType);
    if (colorType === 0) {
      const sample = sampleAt(row, base, bitDepth);
      const gray = scaleSample(sample, bitDepth);
      plot(x, gray, gray, gray, grayKey === sample ? 0 : 255);
    } else if (colorType === 2) {
      const sr = sampleAt(row, base, bitDepth);
      const sg = sampleAt(row, base + 1, bitDepth);
      const sb = sampleAt(row, base + 2, bitDepth);
      const a =
        rgbKey !== undefined && rgbKey[0] === sr && rgbKey[1] === sg && rgbKey[2] === sb ? 0 : 255;
      plot(x, scaleSample(sr, bitDepth), scaleSample(sg, bitDepth), scaleSample(sb, bitDepth), a);
    } else if (colorType === 4) {
      const gray = scaleSample(sampleAt(row, base, bitDepth), bitDepth);
      const alpha = scaleSample(sampleAt(row, base + 1, bitDepth), bitDepth);
      plot(x, gray, gray, gray, alpha);
    } else {
      plot(
        x,
        scaleSample(sampleAt(row, base, bitDepth), bitDepth),
        scaleSample(sampleAt(row, base + 1, bitDepth), bitDepth),
        scaleSample(sampleAt(row, base + 2, bitDepth), bitDepth),
        scaleSample(sampleAt(row, base + 3, bitDepth), bitDepth),
      );
    }
  }
}

function parsePalette(
  plte: Uint8Array,
  trns: Uint8Array | undefined,
): Array<{ r: number; g: number; b: number; a: number }> {
  if (plte.length === 0 || plte.length % 3 !== 0) {
    throw pngError("PLTE length must be a non-zero multiple of 3");
  }
  const n = plte.length / 3;
  const colors: Array<{ r: number; g: number; b: number; a: number }> = [];
  for (let i = 0; i < n; i++) {
    const r = plte[i * 3] ?? 0;
    const g = plte[i * 3 + 1] ?? 0;
    const b = plte[i * 3 + 2] ?? 0;
    const a = trns?.[i] ?? 255;
    colors.push({ r, g, b, a });
  }
  return colors;
}

export function parsePngIhdr(data: Uint8Array): PngIhdrInfo {
  if (data.length !== 13) {
    throw pngError("must start with a 13-byte IHDR");
  }
  const width = readUint32BE(data, 0);
  const height = readUint32BE(data, 4);
  const bitDepth = data[8] ?? 0;
  const colorType = data[9] ?? 0;
  const compression = data[10] ?? 0;
  const filter = data[11] ?? 0;
  const interlace = data[12] ?? 0;
  if (compression !== 0) {
    throw pngError("unsupported compression method");
  }
  if (filter !== 0) {
    throw pngError("unsupported filter method");
  }
  if (interlace !== 0 && interlace !== 1) {
    throw pngError("unsupported interlace method");
  }
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8 && bitDepth !== 16) {
    throw pngError(`unsupported bit depth ${bitDepth}`);
  }
  if (bitDepth === 16 && colorType === 3) {
    throw pngError("indexed PNG cannot be 16-bit");
  }
  channelCount(colorType);
  return { width, height, bitDepth, colorType, interlace };
}

export function pngColorState(chunks: readonly PngChunk[], colorType: number): PngColorState {
  const plte = firstChunk(chunks, "PLTE");
  const trns = firstChunk(chunks, "tRNS");
  const palette =
    colorType === 3 ? parsePalette(plte?.data ?? new Uint8Array(), trns?.data) : undefined;

  let grayKey: number | undefined;
  let rgbKey: readonly [number, number, number] | undefined;
  if (trns !== undefined && colorType === 0) {
    if (trns.data.length !== 2) {
      throw pngError("tRNS for grayscale must be 2 bytes");
    }
    grayKey = readUint16BE(trns.data, 0);
  }
  if (trns !== undefined && colorType === 2) {
    if (trns.data.length !== 6) {
      throw pngError("tRNS for RGB must be 6 bytes");
    }
    rgbKey = [readUint16BE(trns.data, 0), readUint16BE(trns.data, 2), readUint16BE(trns.data, 4)];
  }
  return { palette, grayKey, rgbKey };
}

export function expectedInflatedSize(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): number {
  if (interlace === 0) {
    return height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  }
  let total = 0;
  for (const pass of ADAM7) {
    const pw = passExtent(width, pass.x0, pass.dx);
    const ph = passExtent(height, pass.y0, pass.dy);
    if (pw === 0 || ph === 0) {
      continue;
    }
    total += ph * (1 + Math.ceil((pw * bitsPerPixel) / 8));
  }
  return total;
}

/**
 * Decoded RGBA (`width × height`) plus the 16-bit raw scanline buffer
 * (2 bytes/sample, including Adam7 pass layout). 8-bit inflates are smaller
 * than the RGBA output so `checkDimensions` already covers them.
 */
export function checkPngDecodeBudget(header: PngIhdrInfo, maxPixels?: number): void {
  checkDimensions("PNG", header.width, header.height, maxPixels);
  if (header.bitDepth !== 16) {
    return;
  }
  const limit = maxPixels ?? DEFAULT_MAX_PIXELS;
  const bitsPerPixel = header.bitDepth * channelCount(header.colorType);
  const scanlineBytes = expectedInflatedSize(
    header.width,
    header.height,
    bitsPerPixel,
    header.interlace,
  );
  const rgbaBytes = header.width * header.height * 4;
  const totalBytes = rgbaBytes + scanlineBytes;
  const budgetBytes = limit * 4;
  if (totalBytes > budgetBytes) {
    throw pngError(
      `${header.width}x${header.height} 16-bit exceeds maxPixels (decoded RGBA + 16-bit scanlines ${totalBytes} > ${budgetBytes})`,
    );
  }
}

export function resolvePngOrientation(
  value: PngDecodeOptions["orientation"],
): NonNullable<PngDecodeOptions["orientation"]> {
  // Untyped JS callers can pass anything: check the runtime value, not the type.
  const mode: unknown = value ?? "apply";
  if (mode !== "apply" && mode !== "ignore") {
    throw pngRangeError('orientation must be "apply" or "ignore"');
  }
  return mode;
}

export function applyPngOrientation(
  image: PixelBuffer,
  chunks: readonly PngChunk[],
  mode: NonNullable<PngDecodeOptions["orientation"]>,
): PixelBuffer {
  if (mode === "ignore") {
    return image;
  }
  const exif = firstChunk(chunks, "eXIf");
  return applyOrientation(image, exifOrientation(exif?.data));
}

/** Inflate a zlib image (IDAT / fdAT payload) to packed 8-bit RGBA. */
export function decodePngZlibToRgba(
  compressed: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
  color: PngColorState,
): Uint8Array {
  const channels = channelCount(colorType);
  const bitsPerPixel = bitDepth * channels;
  const bytesPerPixel = Math.max(1, Math.floor(bitsPerPixel / 8));
  const expected = expectedInflatedSize(width, height, bitsPerPixel, interlace);
  const inflated = zlibInflate(compressed, expected, expected);
  if (inflated.length !== expected) {
    throw pngError("inflated IDAT length does not match scanlines");
  }
  const rgba = new Uint8Array(width * height * 4);
  const { palette, grayKey, rgbKey } = color;

  if (interlace === 0) {
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const lines = unfilterImage(inflated, height, stride, bytesPerPixel);
    for (let y = 0; y < height; y++) {
      const row = lines[y] ?? new Uint8Array(stride);
      unpackLine(row, width, bitDepth, colorType, palette, grayKey, rgbKey, (x, r, g, b, a) => {
        writePixel(rgba, width, x, y, r, g, b, a);
      });
    }
    return rgba;
  }

  let offset = 0;
  for (const pass of ADAM7) {
    const pw = passExtent(width, pass.x0, pass.dx);
    const ph = passExtent(height, pass.y0, pass.dy);
    if (pw === 0 || ph === 0) {
      continue;
    }
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    const passBytes = ph * (1 + stride);
    const slice = inflated.subarray(offset, offset + passBytes);
    const lines = unfilterImage(slice, ph, stride, bytesPerPixel);
    offset += passBytes;
    for (let py = 0; py < ph; py++) {
      const row = lines[py] ?? new Uint8Array(stride);
      const y = pass.y0 + py * pass.dy;
      unpackLine(row, pw, bitDepth, colorType, palette, grayKey, rgbKey, (px, r, g, b, a) => {
        writePixel(rgba, width, pass.x0 + px * pass.dx, y, r, g, b, a);
      });
    }
  }
  return rgba;
}

/** Decode a PNG to packed 8-bit RGBA. Sequential and Adam7. First IDAT frame only (not APNG). */
export function decodePng(bytes: Uint8Array, options?: PngDecodeOptions): PixelBuffer {
  const orientation = resolvePngOrientation(options?.orientation);
  const chunks = parsePngChunks(bytes);
  const ihdr = chunks[0];
  if (ihdr === undefined || ihdr.type !== "IHDR") {
    throw pngError("must start with a 13-byte IHDR");
  }
  const header = parsePngIhdr(ihdr.data);
  checkPngDecodeBudget(header, options?.maxPixels);
  const color = pngColorState(chunks, header.colorType);
  const data = decodePngZlibToRgba(
    concatIdat(chunks),
    header.width,
    header.height,
    header.bitDepth,
    header.colorType,
    header.interlace,
    color,
  );
  return applyPngOrientation(
    { width: header.width, height: header.height, data },
    chunks,
    orientation,
  );
}
