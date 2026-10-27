import { pngError } from "./error.ts";

export type PngFilter = "none" | "sub" | "up" | "average" | "paeth" | "adaptive";

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;

export function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function absDeviationSum(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] ?? 0;
    sum += b < 128 ? b : 256 - b;
  }
  return sum;
}

function applyFilter(
  type: number,
  raw: Uint8Array,
  prev: Uint8Array | undefined,
  bytesPerPixel: number,
  out: Uint8Array,
): void {
  const stride = raw.length;
  for (let i = 0; i < stride; i++) {
    const x = raw[i] ?? 0;
    const left = i >= bytesPerPixel ? (raw[i - bytesPerPixel] ?? 0) : 0;
    const up = prev?.[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? (prev?.[i - bytesPerPixel] ?? 0) : 0;
    let predictor = 0;
    if (type === FILTER_SUB) {
      predictor = left;
    } else if (type === FILTER_UP) {
      predictor = up;
    } else if (type === FILTER_AVERAGE) {
      predictor = (left + up) >> 1;
    } else if (type === FILTER_PAETH) {
      predictor = paethPredictor(left, up, upLeft);
    }
    out[i] = (x - predictor) & 0xff;
  }
}

function filterTypeCode(strategy: Exclude<PngFilter, "adaptive">): number {
  switch (strategy) {
    case "none":
      return FILTER_NONE;
    case "sub":
      return FILTER_SUB;
    case "up":
      return FILTER_UP;
    case "average":
      return FILTER_AVERAGE;
    case "paeth":
      return FILTER_PAETH;
  }
}

/** Reconstruct raw scanlines from filter-type + filtered bytes. */
/**
 * Reverse the per-row filters in place: each row's bytes are overwritten with
 * the raw scanline (the filter-type byte is left as is). Returns one view per
 * row into `filtered`; no copy of the image is made, so decode peaks at the
 * inflated buffer plus the RGBA output.
 */
export function unfilterImage(
  filtered: Uint8Array,
  height: number,
  stride: number,
  bytesPerPixel: number,
): Uint8Array[] {
  const rowSize = 1 + stride;
  if (filtered.length !== height * rowSize) {
    throw pngError("inflated IDAT length does not match scanlines");
  }
  const lines: Uint8Array[] = [];
  let prev: Uint8Array | undefined;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    const type = filtered[rowStart] ?? 0;
    if (type > FILTER_PAETH) {
      throw pngError(`unsupported filter type ${type}`);
    }
    const raw = filtered.subarray(rowStart + 1, rowStart + rowSize);
    if (type !== FILTER_NONE) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bytesPerPixel ? (raw[i - bytesPerPixel] ?? 0) : 0;
        const up = prev?.[i] ?? 0;
        let predictor = 0;
        if (type === FILTER_SUB) {
          predictor = left;
        } else if (type === FILTER_UP) {
          predictor = up;
        } else if (type === FILTER_AVERAGE) {
          predictor = (left + up) >> 1;
        } else {
          const upLeft = i >= bytesPerPixel ? (prev?.[i - bytesPerPixel] ?? 0) : 0;
          predictor = paethPredictor(left, up, upLeft);
        }
        raw[i] = ((raw[i] ?? 0) + predictor) & 0xff;
      }
    }
    lines.push(raw);
    prev = raw;
  }
  return lines;
}

export function filterImage(
  lines: readonly Uint8Array[],
  bytesPerPixel: number,
  strategy: PngFilter,
): Uint8Array {
  const height = lines.length;
  if (height === 0) {
    return new Uint8Array(0);
  }
  const stride = lines[0]?.length ?? 0;
  const out = new Uint8Array(height * (1 + stride));

  if (strategy !== "adaptive") {
    const type = filterTypeCode(strategy);
    for (let y = 0; y < height; y++) {
      const raw = lines[y] ?? new Uint8Array(stride);
      const prev = y > 0 ? lines[y - 1] : undefined;
      const rowStart = y * (1 + stride);
      out[rowStart] = type;
      applyFilter(
        type,
        raw,
        prev,
        bytesPerPixel,
        out.subarray(rowStart + 1, rowStart + 1 + stride),
      );
    }
    return out;
  }

  const scratches = [
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
  ];

  for (let y = 0; y < height; y++) {
    const raw = lines[y] ?? new Uint8Array(stride);
    const prev = y > 0 ? lines[y - 1] : undefined;
    let bestType = FILTER_NONE;
    let bestScore = Infinity;
    for (let type = FILTER_NONE; type <= FILTER_PAETH; type++) {
      const scratch = scratches[type] ?? new Uint8Array(stride);
      applyFilter(type, raw, prev, bytesPerPixel, scratch);
      const score = absDeviationSum(scratch);
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
    const rowStart = y * (1 + stride);
    out[rowStart] = bestType;
    const winner = scratches[bestType] ?? new Uint8Array(stride);
    out.set(winner, rowStart + 1);
  }

  return out;
}
