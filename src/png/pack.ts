import type { ColorAnalysis } from "./color.ts";
import { pngRangeError } from "./error.ts";

export type PackedScanlines = {
  readonly bytesPerPixel: number;
  readonly lines: Uint8Array[];
  readonly plte?: Uint8Array;
  readonly trns?: Uint8Array;
};

function bitsPerPixel(analysis: ColorAnalysis): number {
  switch (analysis.kind) {
    case "gray":
    case "palette":
      return analysis.bitDepth;
    case "gray-alpha":
      return 16;
    case "rgb":
      return 24;
    case "rgba":
      return 32;
  }
}

function graySample(value: number, bitDepth: 1 | 2 | 4 | 8): number {
  if (bitDepth === 8) {
    return value;
  }
  if (bitDepth === 1) {
    return value === 255 ? 1 : 0;
  }
  if (bitDepth === 2) {
    return (value / 85) | 0;
  }
  return (value / 17) | 0;
}

function packMsbFirst(samples: Uint8Array, width: number, bitDepth: 1 | 2 | 4): Uint8Array {
  const stride = Math.ceil((width * bitDepth) / 8);
  const out = new Uint8Array(stride);
  const mask = (1 << bitDepth) - 1;
  let acc = 0;
  let bitsLeft = 8;
  let byteIndex = 0;
  for (let x = 0; x < width; x++) {
    const sample = (samples[x] ?? 0) & mask;
    bitsLeft -= bitDepth;
    acc |= sample << bitsLeft;
    if (bitsLeft === 0) {
      out[byteIndex] = acc;
      byteIndex += 1;
      acc = 0;
      bitsLeft = 8;
    }
  }
  if (bitsLeft !== 8) {
    out[byteIndex] = acc;
  }
  return out;
}

function rgbaKey(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function buildPaletteChunks(palette: readonly number[]): {
  readonly plte: Uint8Array;
  readonly trns?: Uint8Array;
} {
  const plte = new Uint8Array(palette.length * 3);
  const alphas = new Uint8Array(palette.length);
  let lastTransparent = -1;
  for (let i = 0; i < palette.length; i++) {
    const color = palette[i] ?? 0;
    plte[i * 3] = (color >>> 24) & 0xff;
    plte[i * 3 + 1] = (color >>> 16) & 0xff;
    plte[i * 3 + 2] = (color >>> 8) & 0xff;
    const alpha = color & 0xff;
    alphas[i] = alpha;
    if (alpha !== 255) {
      lastTransparent = i;
    }
  }
  if (lastTransparent < 0) {
    return { plte };
  }
  return { plte, trns: alphas.subarray(0, lastTransparent + 1) };
}

export function packScanlines(
  data: Uint8Array,
  width: number,
  height: number,
  analysis: ColorAnalysis,
): PackedScanlines {
  if (data.length !== width * height * 4) {
    throw pngRangeError("RGBA data length must equal width * height * 4");
  }

  const bppBits = bitsPerPixel(analysis);
  const bytesPerPixel = Math.max(1, Math.floor(bppBits / 8));
  const lines: Uint8Array[] = [];

  if (analysis.kind === "rgba") {
    for (let y = 0; y < height; y++) {
      const start = y * width * 4;
      lines.push(data.subarray(start, start + width * 4));
    }
    return { bytesPerPixel, lines };
  }

  if (analysis.kind === "rgb") {
    for (let y = 0; y < height; y++) {
      const line = new Uint8Array(width * 3);
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const src = row + x * 4;
        const dst = x * 3;
        line[dst] = data[src] ?? 0;
        line[dst + 1] = data[src + 1] ?? 0;
        line[dst + 2] = data[src + 2] ?? 0;
      }
      lines.push(line);
    }
    return { bytesPerPixel, lines };
  }

  if (analysis.kind === "gray-alpha") {
    for (let y = 0; y < height; y++) {
      const line = new Uint8Array(width * 2);
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const src = row + x * 4;
        const dst = x * 2;
        line[dst] = data[src] ?? 0;
        line[dst + 1] = data[src + 3] ?? 0;
      }
      lines.push(line);
    }
    return { bytesPerPixel, lines };
  }

  if (analysis.kind === "gray") {
    const depth = analysis.bitDepth;
    for (let y = 0; y < height; y++) {
      const samples = new Uint8Array(width);
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        samples[x] = graySample(data[row + x * 4] ?? 0, depth);
      }
      lines.push(depth === 8 ? samples : packMsbFirst(samples, width, depth));
    }
    return { bytesPerPixel, lines };
  }

  const indexOf = new Map<number, number>();
  for (let i = 0; i < analysis.palette.length; i++) {
    const color = analysis.palette[i];
    if (color !== undefined) {
      indexOf.set(color, i);
    }
  }

  const depth = analysis.bitDepth;
  for (let y = 0; y < height; y++) {
    const samples = new Uint8Array(width);
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const src = row + x * 4;
      const key = rgbaKey(
        data[src] ?? 0,
        data[src + 1] ?? 0,
        data[src + 2] ?? 0,
        data[src + 3] ?? 0,
      );
      const index = indexOf.get(key);
      if (index === undefined) {
        throw pngRangeError("pixel color is not in the palette");
      }
      samples[x] = index;
    }
    lines.push(depth === 8 ? samples : packMsbFirst(samples, width, depth));
  }

  const chunks = buildPaletteChunks(analysis.palette);
  if (chunks.trns === undefined) {
    return { bytesPerPixel, lines, plte: chunks.plte };
  }
  return { bytesPerPixel, lines, plte: chunks.plte, trns: chunks.trns };
}
