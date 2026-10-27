/**
 * Separable RGBA resize. Horizontal then vertical, with filter support stretched
 * by the downscale ratio so large reductions do not alias. Filtering is done in
 * premultiplied alpha (skipped when every pixel is opaque).
 */

import { checkDimensions } from "./limits.ts";
import { createPixelBuffer, type PixelBuffer } from "./pixels.ts";

export type ResizeOptions = {
  /** Longest side after resize. Aspect preserved. Never upscales unless `upscale: true`. */
  readonly maxSide?: number;
  /** Exact target size (aspect NOT preserved). Mutually exclusive with maxSide. */
  readonly width?: number;
  readonly height?: number;
  /** Default false: images already within bounds are returned as-is (same object). */
  readonly upscale?: boolean;
  /** Default "lanczos3". "box" is area-average (fast, fine for ≥2× downscale). */
  readonly filter?: "lanczos3" | "box";
};

type FilterName = "lanczos3" | "box";

/** Per-output-pixel 1D contribution windows. Weights already sum to 1. */
type Contribs = {
  readonly starts: Int32Array;
  readonly counts: Int32Array;
  readonly weights: Float32Array;
  readonly maxCount: number;
};

const INV_255 = 1 / 255;
const LANCZOS_RADIUS = 3;
const PI = Math.PI;

export function fitSize(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  requirePositiveInt(width, "width");
  requirePositiveInt(height, "height");
  requirePositiveInt(maxSide, "maxSide");
  const longSide = width > height ? width : height;
  if (longSide <= maxSide) {
    return { width, height };
  }
  const scale = maxSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function resize(image: PixelBuffer, options: ResizeOptions): PixelBuffer {
  const srcW = image.width;
  const srcH = image.height;
  const src = image.data;
  if (!Number.isInteger(srcW) || !Number.isInteger(srcH) || srcW <= 0 || srcH <= 0) {
    throw new RangeError("width and height must be positive integers");
  }
  if (src.length !== srcW * srcH * 4) {
    throw new RangeError("RGBA data length must equal width * height * 4");
  }
  const { dstW, dstH, filter } = resolveTarget(srcW, srcH, options);
  if (dstW === srcW && dstH === srcH) {
    return image;
  }
  // The source is already in memory, so only growth needs a budget: a
  // downscale never allocates more than the caller already holds (this is what
  // lets `shrinkImage` honor a caller's `maxPixels` above the default).
  if (dstW * dstH > srcW * srcH) {
    checkDimensions("resize", dstW, dstH);
  }

  const opaque = isFullyOpaque(src);
  const out = createPixelBuffer(dstW, dstH);
  const horiz = dstW !== srcW ? buildContribs(srcW, dstW, filter) : undefined;
  const vert = dstH !== srcH ? buildContribs(srcH, dstH, filter) : undefined;

  if (horiz !== undefined && vert !== undefined) {
    const mid = new Float32Array(dstW * srcH * 4);
    resampleHorizU8ToF32(src, srcW, srcH, dstW, horiz, opaque, mid);
    resampleVertF32ToU8(mid, dstW, dstH, vert, opaque, out.data);
    return out;
  }
  if (horiz !== undefined) {
    resampleHorizU8ToU8(src, srcW, srcH, dstW, horiz, opaque, out.data);
    return out;
  }
  if (vert !== undefined) {
    resampleVertU8ToU8(src, srcW, dstH, vert, opaque, out.data);
    return out;
  }
  return image;
}

function resolveTarget(
  srcW: number,
  srcH: number,
  options: ResizeOptions,
): { dstW: number; dstH: number; filter: FilterName } {
  // Untyped JS callers can pass anything: check the runtime value, not the type.
  const filter: unknown = options.filter ?? "lanczos3";
  if (filter !== "lanczos3" && filter !== "box") {
    throw new RangeError('filter must be "lanczos3" or "box"');
  }
  const upscale = options.upscale === true;
  const hasMax = options.maxSide !== undefined;
  const hasW = options.width !== undefined;
  const hasH = options.height !== undefined;

  if (hasMax && (hasW || hasH)) {
    throw new RangeError("maxSide and width/height are mutually exclusive");
  }
  if (!hasMax && !(hasW && hasH)) {
    throw new RangeError("provide maxSide, or both width and height");
  }

  if (hasMax) {
    const maxSide = options.maxSide;
    requirePositiveInt(maxSide, "maxSide");
    if (!upscale) {
      const fit = fitSize(srcW, srcH, maxSide);
      return { dstW: fit.width, dstH: fit.height, filter };
    }
    const longSide = srcW > srcH ? srcW : srcH;
    const scale = maxSide / longSide;
    return {
      dstW: Math.max(1, Math.round(srcW * scale)),
      dstH: Math.max(1, Math.round(srcH * scale)),
      filter,
    };
  }

  const width = options.width;
  const height = options.height;
  requirePositiveInt(width, "width");
  requirePositiveInt(height, "height");
  const dstW = upscale ? width : Math.min(width, srcW);
  const dstH = upscale ? height : Math.min(height, srcH);
  return { dstW, dstH, filter };
}

function requirePositiveInt(value: number | undefined, name: string): asserts value is number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function isFullyOpaque(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      return false;
    }
  }
  return true;
}

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  const px = PI * x;
  return Math.sin(px) / px;
}

function lanczos3(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax >= LANCZOS_RADIUS) {
    return 0;
  }
  return sinc(x) * sinc(x / LANCZOS_RADIUS);
}

function buildContribs(src: number, dst: number, filter: FilterName): Contribs {
  if (filter === "box") {
    return buildBoxContribs(src, dst);
  }
  return buildLanczosContribs(src, dst);
}

/** Area-average: output pixel i covers input [i * src/dst, (i+1) * src/dst). */
function buildBoxContribs(src: number, dst: number): Contribs {
  const ratio = src / dst;
  const maxCount = Math.min(src, Math.max(1, Math.ceil(ratio) + 1));
  const starts = new Int32Array(dst);
  const counts = new Int32Array(dst);
  const weights = new Float32Array(dst * maxCount);

  for (let i = 0; i < dst; i++) {
    const in0 = i * ratio;
    const in1 = (i + 1) * ratio;
    let j0 = Math.floor(in0);
    let j1 = Math.ceil(in1) - 1;
    if (j0 < 0) {
      j0 = 0;
    }
    if (j1 >= src) {
      j1 = src - 1;
    }
    if (j1 < j0) {
      j0 = Math.min(src - 1, Math.max(0, Math.floor((in0 + in1) * 0.5)));
      j1 = j0;
    }
    const count = j1 - j0 + 1;
    const base = i * maxCount;
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const j = j0 + k;
      const overlap = Math.min(in1, j + 1) - Math.max(in0, j);
      const w = overlap > 0 ? overlap : 0;
      weights[base + k] = w;
      sum += w;
    }
    if (sum <= 0) {
      starts[i] = j0;
      counts[i] = 1;
      weights[base] = 1;
      continue;
    }
    const inv = 1 / sum;
    for (let k = 0; k < count; k++) {
      weights[base + k] = (weights[base + k] ?? 0) * inv;
    }
    starts[i] = j0;
    counts[i] = count;
  }
  return { starts, counts, weights, maxCount };
}

function buildLanczosContribs(src: number, dst: number): Contribs {
  const ratio = src / dst;
  const scale = ratio > 1 ? ratio : 1;
  const support = LANCZOS_RADIUS * scale;
  const maxCount = Math.min(src, Math.floor(2 * support) + 3);
  const starts = new Int32Array(dst);
  const counts = new Int32Array(dst);
  const weights = new Float32Array(dst * maxCount);

  for (let i = 0; i < dst; i++) {
    const center = (i + 0.5) * ratio - 0.5;
    let j0 = Math.floor(center - support);
    let j1 = Math.ceil(center + support);
    if (j0 < 0) {
      j0 = 0;
    }
    if (j1 >= src) {
      j1 = src - 1;
    }
    if (j1 < j0) {
      j0 = 0;
      j1 = 0;
    }
    const count = j1 - j0 + 1;
    const base = i * maxCount;
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const w = lanczos3((j0 + k - center) / scale);
      weights[base + k] = w;
      sum += w;
    }
    if (sum <= 0) {
      const nearest = Math.min(src - 1, Math.max(0, Math.round(center)));
      starts[i] = nearest;
      counts[i] = 1;
      weights[base] = 1;
      continue;
    }
    const inv = 1 / sum;
    for (let k = 0; k < count; k++) {
      weights[base + k] = (weights[base + k] ?? 0) * inv;
    }
    starts[i] = j0;
    counts[i] = count;
  }
  return { starts, counts, weights, maxCount };
}

function roundU8(v: number): number {
  if (v <= 0) {
    return 0;
  }
  if (v >= 255) {
    return 255;
  }
  return (v + 0.5) | 0;
}

function storeU8(
  out: Uint8Array,
  di: number,
  r: number,
  g: number,
  b: number,
  a: number,
  opaque: boolean,
): void {
  if (opaque) {
    out[di] = roundU8(r);
    out[di + 1] = roundU8(g);
    out[di + 2] = roundU8(b);
    out[di + 3] = 255;
    return;
  }
  const a8 = roundU8(a);
  if (a8 === 0) {
    out[di] = 0;
    out[di + 1] = 0;
    out[di + 2] = 0;
    out[di + 3] = 0;
    return;
  }
  const inv = 255 / a;
  out[di] = roundU8(r * inv);
  out[di + 1] = roundU8(g * inv);
  out[di + 2] = roundU8(b * inv);
  out[di + 3] = a8;
}

function resampleHorizU8ToF32(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  contrib: Contribs,
  opaque: boolean,
  dst: Float32Array,
): void {
  const { starts, counts, weights, maxCount } = contrib;
  const srcRowBytes = srcW * 4;
  const dstRowBytes = dstW * 4;
  if (opaque) {
    for (let y = 0; y < srcH; y++) {
      const srcRow = y * srcRowBytes;
      const dstRow = y * dstRowBytes;
      for (let x = 0; x < dstW; x++) {
        const start = starts[x] ?? 0;
        const count = counts[x] ?? 0;
        const wbase = x * maxCount;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let k = 0; k < count; k++) {
          const w = weights[wbase + k] ?? 0;
          const si = srcRow + ((start + k) << 2);
          r += (src[si] ?? 0) * w;
          g += (src[si + 1] ?? 0) * w;
          b += (src[si + 2] ?? 0) * w;
        }
        const di = dstRow + (x << 2);
        dst[di] = r;
        dst[di + 1] = g;
        dst[di + 2] = b;
        dst[di + 3] = 255;
      }
    }
    return;
  }
  for (let y = 0; y < srcH; y++) {
    const srcRow = y * srcRowBytes;
    const dstRow = y * dstRowBytes;
    for (let x = 0; x < dstW; x++) {
      const start = starts[x] ?? 0;
      const count = counts[x] ?? 0;
      const wbase = x * maxCount;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < count; k++) {
        const w = weights[wbase + k] ?? 0;
        const si = srcRow + ((start + k) << 2);
        const av = src[si + 3] ?? 0;
        const aw = av * w;
        a += aw;
        const s = aw * INV_255;
        r += (src[si] ?? 0) * s;
        g += (src[si + 1] ?? 0) * s;
        b += (src[si + 2] ?? 0) * s;
      }
      const di = dstRow + (x << 2);
      dst[di] = r;
      dst[di + 1] = g;
      dst[di + 2] = b;
      dst[di + 3] = a;
    }
  }
}

function resampleHorizU8ToU8(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  contrib: Contribs,
  opaque: boolean,
  dst: Uint8Array,
): void {
  const { starts, counts, weights, maxCount } = contrib;
  const srcRowBytes = srcW * 4;
  const dstRowBytes = dstW * 4;
  if (opaque) {
    for (let y = 0; y < srcH; y++) {
      const srcRow = y * srcRowBytes;
      const dstRow = y * dstRowBytes;
      for (let x = 0; x < dstW; x++) {
        const start = starts[x] ?? 0;
        const count = counts[x] ?? 0;
        const wbase = x * maxCount;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let k = 0; k < count; k++) {
          const w = weights[wbase + k] ?? 0;
          const si = srcRow + ((start + k) << 2);
          r += (src[si] ?? 0) * w;
          g += (src[si + 1] ?? 0) * w;
          b += (src[si + 2] ?? 0) * w;
        }
        storeU8(dst, dstRow + (x << 2), r, g, b, 255, true);
      }
    }
    return;
  }
  for (let y = 0; y < srcH; y++) {
    const srcRow = y * srcRowBytes;
    const dstRow = y * dstRowBytes;
    for (let x = 0; x < dstW; x++) {
      const start = starts[x] ?? 0;
      const count = counts[x] ?? 0;
      const wbase = x * maxCount;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < count; k++) {
        const w = weights[wbase + k] ?? 0;
        const si = srcRow + ((start + k) << 2);
        const av = src[si + 3] ?? 0;
        const aw = av * w;
        a += aw;
        const s = aw * INV_255;
        r += (src[si] ?? 0) * s;
        g += (src[si + 1] ?? 0) * s;
        b += (src[si + 2] ?? 0) * s;
      }
      storeU8(dst, dstRow + (x << 2), r, g, b, a, false);
    }
  }
}

function resampleVertF32ToU8(
  src: Float32Array,
  width: number,
  dstH: number,
  contrib: Contribs,
  opaque: boolean,
  dst: Uint8Array,
): void {
  const { starts, counts, weights, maxCount } = contrib;
  const rowBytes = width * 4;
  const acc = new Float32Array(rowBytes);
  for (let y = 0; y < dstH; y++) {
    const start = starts[y] ?? 0;
    const count = counts[y] ?? 0;
    const wbase = y * maxCount;
    acc.fill(0);
    for (let k = 0; k < count; k++) {
      const w = weights[wbase + k] ?? 0;
      const srcRow = (start + k) * rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        acc[i] = (acc[i] ?? 0) + (src[srcRow + i] ?? 0) * w;
      }
    }
    const dstRow = y * rowBytes;
    if (opaque) {
      for (let x = 0; x < width; x++) {
        const ai = x << 2;
        storeU8(dst, dstRow + ai, acc[ai] ?? 0, acc[ai + 1] ?? 0, acc[ai + 2] ?? 0, 255, true);
      }
    } else {
      for (let x = 0; x < width; x++) {
        const ai = x << 2;
        storeU8(
          dst,
          dstRow + ai,
          acc[ai] ?? 0,
          acc[ai + 1] ?? 0,
          acc[ai + 2] ?? 0,
          acc[ai + 3] ?? 0,
          false,
        );
      }
    }
  }
}

function resampleVertU8ToU8(
  src: Uint8Array,
  width: number,
  dstH: number,
  contrib: Contribs,
  opaque: boolean,
  dst: Uint8Array,
): void {
  const { starts, counts, weights, maxCount } = contrib;
  const rowBytes = width * 4;
  const acc = new Float32Array(rowBytes);
  for (let y = 0; y < dstH; y++) {
    const start = starts[y] ?? 0;
    const count = counts[y] ?? 0;
    const wbase = y * maxCount;
    acc.fill(0);
    if (opaque) {
      for (let k = 0; k < count; k++) {
        const w = weights[wbase + k] ?? 0;
        const srcRow = (start + k) * rowBytes;
        for (let x = 0; x < width; x++) {
          const i = x << 2;
          acc[i] = (acc[i] ?? 0) + (src[srcRow + i] ?? 0) * w;
          acc[i + 1] = (acc[i + 1] ?? 0) + (src[srcRow + i + 1] ?? 0) * w;
          acc[i + 2] = (acc[i + 2] ?? 0) + (src[srcRow + i + 2] ?? 0) * w;
        }
      }
      const dstRow = y * rowBytes;
      for (let x = 0; x < width; x++) {
        const ai = x << 2;
        storeU8(dst, dstRow + ai, acc[ai] ?? 0, acc[ai + 1] ?? 0, acc[ai + 2] ?? 0, 255, true);
      }
      continue;
    }
    for (let k = 0; k < count; k++) {
      const w = weights[wbase + k] ?? 0;
      const srcRow = (start + k) * rowBytes;
      for (let x = 0; x < width; x++) {
        const i = x << 2;
        const av = src[srcRow + i + 3] ?? 0;
        const aw = av * w;
        acc[i + 3] = (acc[i + 3] ?? 0) + aw;
        const s = aw * INV_255;
        acc[i] = (acc[i] ?? 0) + (src[srcRow + i] ?? 0) * s;
        acc[i + 1] = (acc[i + 1] ?? 0) + (src[srcRow + i + 1] ?? 0) * s;
        acc[i + 2] = (acc[i + 2] ?? 0) + (src[srcRow + i + 2] ?? 0) * s;
      }
    }
    const dstRow = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const ai = x << 2;
      storeU8(
        dst,
        dstRow + ai,
        acc[ai] ?? 0,
        acc[ai + 1] ?? 0,
        acc[ai + 2] ?? 0,
        acc[ai + 3] ?? 0,
        false,
      );
    }
  }
}
