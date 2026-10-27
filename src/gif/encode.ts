import type { PixelBuffer } from "../pixels.ts";
import { rgbaKey } from "../png/color.ts";
import {
  indexPalette,
  nearestPaletteIndex,
  quantizeToPalette,
  type PaletteIndex,
} from "../png/quantize.ts";
import { gifError } from "./error.ts";
import { encodeLzw } from "./lzw.ts";

/** 65535 centiseconds, the GCE field width, expressed in milliseconds. */
const MAX_DELAY_MS = 655350;
const MAX_DELAY_CS = 65535;

export type GifFrame = PixelBuffer & {
  /**
   * Delay in milliseconds. GIF stores centiseconds; encode rounds to nearest cs
   * (minimum 0). Default 100 for animations. `0` stays `0`.
   */
  readonly delay?: number;
  /** GIF disposal 0–3. Default 2 for a 1-frame list. Multi-frame encode chooses 1 or 2. */
  readonly disposal?: number;
};

export type GifEncodeOptions = {
  /** 2–256, default 256. Uses existing PNG median-cut on opaque pixels. */
  readonly maxColors?: number;
  /**
   * Loop count. `undefined` (default) writes no NETSCAPE block (play once).
   * `0` writes NETSCAPE loop forever. `n` writes NETSCAPE `n`.
   */
  readonly loop?: number;
  /**
   * Color table strategy. `"local"` (default) writes a per-frame table when the
   * frame's colors are not a subset of the global table. `"global"` quantizes
   * every frame into one shared table.
   */
  readonly palette?: "local" | "global";
  /** Error diffusion. Default `"none"` (exact palette snap). */
  readonly dither?: "none" | "floyd-steinberg";
};

const GIF89A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const NETSCAPE20 = new Uint8Array([
  0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
]);
const ALPHA_CUTOFF = 128;

type ColorTable = {
  readonly palette: readonly number[];
  readonly rgb: Uint8Array;
  readonly bits: number;
  readonly transparentIndex: number | undefined;
  readonly backgroundIndex: number;
};

class ByteSink {
  private buf: Uint8Array;
  private len: number;

  constructor() {
    this.buf = new Uint8Array(1024);
    this.len = 0;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len] = value & 0xff;
    this.len += 1;
  }

  u16(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) {
      return;
    }
    let cap = this.buf.length;
    while (cap < need) {
      cap *= 2;
    }
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

function assertPixelBuffer(image: PixelBuffer, label: string): void {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw gifError(`${label}: width and height must be positive integers`);
  }
  if (width > 65535 || height > 65535) {
    throw gifError(`${label}: width and height must be at most 65535`);
  }
  if (data.length !== width * height * 4) {
    throw gifError(`${label}: RGBA data length must equal width * height * 4`);
  }
}

function msToCentiseconds(ms: number): number {
  return Math.min(MAX_DELAY_CS, Math.max(0, Math.round(ms / 10)));
}

function colorTableBits(colorCount: number): number {
  let bits = 1;
  while (1 << bits < colorCount) {
    bits += 1;
  }
  return Math.min(8, Math.max(1, bits));
}

function isTransparentAlpha(a: number): boolean {
  return a < ALPHA_CUTOFF;
}

function rgbKey(r: number, g: number, b: number): number {
  return rgbaKey(r, g, b, 255);
}

function hasTransparentPixels(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (isTransparentAlpha(data[i] ?? 0)) {
      return true;
    }
  }
  return false;
}

function uniqueOpaqueColors(data: Uint8Array): number[] {
  const colors: number[] = [];
  const seen = new Map<number, number>();
  const n = (data.length / 4) | 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (isTransparentAlpha(data[i + 3] ?? 0)) {
      continue;
    }
    const key = rgbKey(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    if (!seen.has(key)) {
      seen.set(key, colors.length);
      colors.push(key);
    }
  }
  return colors;
}

function extractOpaqueRgba(data: Uint8Array): Uint8Array {
  const n = (data.length / 4) | 0;
  const out = new Uint8Array(data.length);
  let w = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (isTransparentAlpha(data[i + 3] ?? 0)) {
      continue;
    }
    out[w] = data[i] ?? 0;
    out[w + 1] = data[i + 1] ?? 0;
    out[w + 2] = data[i + 2] ?? 0;
    out[w + 3] = 255;
    w += 4;
  }
  return out.subarray(0, w);
}

function mostFrequentOpaque(buffers: readonly Uint8Array[]): number | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  for (let b = 0; b < buffers.length; b++) {
    const data = buffers[b];
    if (data === undefined) {
      continue;
    }
    const n = (data.length / 4) | 0;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (isTransparentAlpha(data[i + 3] ?? 0)) {
        continue;
      }
      const key = rgbKey(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next > bestN) {
        bestN = next;
        best = key;
      }
    }
  }
  return best;
}

function quantizeOpaqueColors(buffers: readonly Uint8Array[], maxOpaque: number): number[] {
  const unique: number[] = [];
  const seen = new Map<number, number>();
  for (let b = 0; b < buffers.length; b++) {
    const data = buffers[b];
    if (data === undefined) {
      continue;
    }
    const colors = uniqueOpaqueColors(data);
    for (let i = 0; i < colors.length; i++) {
      const key = colors[i];
      if (key === undefined || seen.has(key)) {
        continue;
      }
      seen.set(key, unique.length);
      unique.push(key);
    }
  }
  if (unique.length <= maxOpaque) {
    return unique;
  }
  if (maxOpaque <= 1) {
    const best = mostFrequentOpaque(buffers);
    return best === undefined ? [] : [best];
  }

  const parts: Uint8Array[] = [];
  let total = 0;
  for (let b = 0; b < buffers.length; b++) {
    const data = buffers[b];
    if (data === undefined) {
      continue;
    }
    const opaque = extractOpaqueRgba(data);
    if (opaque.length === 0) {
      continue;
    }
    parts.push(opaque);
    total += opaque.length;
  }
  if (total === 0) {
    return [];
  }
  const combined = new Uint8Array(total);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) {
      continue;
    }
    combined.set(part, o);
    o += part.length;
  }
  const count = (combined.length / 4) | 0;
  const quantized = quantizeToPalette(combined, count, 1, maxOpaque);
  return [...quantized.analysis.palette];
}

function makeColorTable(opaque: readonly number[], hasTrans: boolean): ColorTable {
  const palette: number[] = [];
  for (let i = 0; i < opaque.length && palette.length < (hasTrans ? 255 : 256); i++) {
    const color = opaque[i];
    if (color !== undefined) {
      palette.push(color);
    }
  }
  let transparentIndex: number | undefined;
  if (hasTrans) {
    transparentIndex = palette.length;
    palette.push(rgbaKey(0, 0, 0, 0));
  }
  if (palette.length === 0) {
    palette.push(rgbaKey(0, 0, 0, 255));
  }

  const bits = colorTableBits(palette.length);
  const tableSize = 1 << bits;
  const rgb = new Uint8Array(tableSize * 3);
  for (let i = 0; i < palette.length && i < tableSize; i++) {
    const color = palette[i] ?? 0;
    rgb[i * 3] = (color >>> 24) & 0xff;
    rgb[i * 3 + 1] = (color >>> 16) & 0xff;
    rgb[i * 3 + 2] = (color >>> 8) & 0xff;
  }
  return {
    palette,
    rgb,
    bits,
    transparentIndex,
    backgroundIndex: transparentIndex ?? 0,
  };
}

function opaqueSet(table: ColorTable): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < table.palette.length; i++) {
    if (table.transparentIndex !== undefined && i === table.transparentIndex) {
      continue;
    }
    const color = table.palette[i];
    if (color !== undefined) {
      set.add(color);
    }
  }
  return set;
}

function canUseTable(data: Uint8Array, table: ColorTable): boolean {
  if (hasTransparentPixels(data) && table.transparentIndex === undefined) {
    return false;
  }
  const allowed = opaqueSet(table);
  const unique = uniqueOpaqueColors(data);
  for (let i = 0; i < unique.length; i++) {
    const color = unique[i];
    if (color === undefined || !allowed.has(color)) {
      return false;
    }
  }
  return true;
}

/** Exact nearest opaque entry (squared RGB distance, ties → lowest index). */
function opaqueLookup(table: ColorTable): PaletteIndex {
  return table.transparentIndex === undefined
    ? indexPalette(table.palette, { ignoreAlpha: true })
    : indexPalette(table.palette, { ignoreAlpha: true, skip: table.transparentIndex });
}

function nearestOpaqueIndex(r: number, g: number, b: number, lookup: PaletteIndex): number {
  return nearestPaletteIndex(r, g, b, 0, lookup);
}

function clampByte(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 255) {
    return 255;
  }
  return Math.round(value);
}

function sourceOpaque(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return false;
  }
  return !isTransparentAlpha(data[(y * width + x) * 4 + 3] ?? 0);
}

function diffuse(
  row: Float32Array,
  rowX: number,
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  errR: number,
  errG: number,
  errB: number,
  weight: number,
): void {
  if (!sourceOpaque(data, width, height, x, y)) {
    return;
  }
  const o = rowX * 3;
  row[o] = (row[o] ?? 0) + errR * weight;
  row[o + 1] = (row[o + 1] ?? 0) + errG * weight;
  row[o + 2] = (row[o + 2] ?? 0) + errB * weight;
}

function indexesFromRgba(
  data: Uint8Array,
  width: number,
  height: number,
  table: ColorTable,
  dither: "none" | "floyd-steinberg",
): Uint8Array {
  const { palette, transparentIndex } = table;
  const n = width * height;
  const out = new Uint8Array(n);
  const lookup = opaqueLookup(table);

  if (dither === "none") {
    const cache = new Map<number, number>();
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (isTransparentAlpha(data[i + 3] ?? 0)) {
        out[p] = transparentIndex ?? 0;
        continue;
      }
      const key = rgbKey(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
      let index = cache.get(key);
      if (index === undefined) {
        index = nearestOpaqueIndex(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, lookup);
        cache.set(key, index);
      }
      out[p] = index;
    }
    return out;
  }

  let cur = new Float32Array(width * 3);
  let next = new Float32Array(width * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (isTransparentAlpha(data[i + 3] ?? 0)) {
        out[p] = transparentIndex ?? 0;
        continue;
      }
      const e = x * 3;
      const r = clampByte((data[i] ?? 0) + (cur[e] ?? 0));
      const g = clampByte((data[i + 1] ?? 0) + (cur[e + 1] ?? 0));
      const b = clampByte((data[i + 2] ?? 0) + (cur[e + 2] ?? 0));
      const index = nearestOpaqueIndex(r, g, b, lookup);
      out[p] = index;
      const color = palette[index] ?? 0;
      const errR = r - ((color >>> 24) & 0xff);
      const errG = g - ((color >>> 16) & 0xff);
      const errB = b - ((color >>> 8) & 0xff);
      diffuse(cur, x + 1, data, width, height, x + 1, y, errR, errG, errB, 7 / 16);
      diffuse(next, x - 1, data, width, height, x - 1, y + 1, errR, errG, errB, 3 / 16);
      diffuse(next, x, data, width, height, x, y + 1, errR, errG, errB, 5 / 16);
      diffuse(next, x + 1, data, width, height, x + 1, y + 1, errR, errG, errB, 1 / 16);
    }
    const tmp = cur;
    cur = next;
    next = tmp;
    next.fill(0);
  }
  return out;
}

function writeSubBlocks(sink: ByteSink, data: Uint8Array): void {
  for (let offset = 0; offset < data.length; offset += 255) {
    const size = Math.min(255, data.length - offset);
    sink.u8(size);
    sink.bytes(data.subarray(offset, offset + size));
  }
  sink.u8(0);
}

function writeGce(
  sink: ByteSink,
  delay: number,
  disposal: number,
  transparentIndex: number | undefined,
): void {
  sink.u8(0x21);
  sink.u8(0xf9);
  sink.u8(0x04);
  let packed = (disposal & 7) << 2;
  if (transparentIndex !== undefined) {
    packed |= 1;
  }
  sink.u8(packed);
  sink.u16(delay);
  sink.u8(transparentIndex ?? 0);
  sink.u8(0);
}

function writeNetscape(sink: ByteSink, loop: number): void {
  sink.u8(0x21);
  sink.u8(0xff);
  sink.u8(11);
  sink.bytes(NETSCAPE20);
  sink.u8(3);
  sink.u8(1);
  sink.u16(loop);
  sink.u8(0);
}

function optionalUint(value: number | undefined, name: string, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw gifError(`${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

function validateEncodeOptions(options: GifEncodeOptions | undefined): {
  readonly maxColors: number;
  readonly loop: number | undefined;
  readonly paletteMode: "local" | "global";
  readonly dither: "none" | "floyd-steinberg";
} {
  const maxColors = options?.maxColors ?? 256;
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) {
    throw gifError("maxColors must be an integer from 2 to 256");
  }
  const loop = optionalUint(options?.loop, "loop", 65535);
  // Options arrive from untyped JS callers too: check the runtime value, not the type.
  const paletteMode: unknown = options?.palette ?? "local";
  if (paletteMode !== "local" && paletteMode !== "global") {
    throw gifError('palette must be "local" or "global"');
  }
  const dither: unknown = options?.dither ?? "none";
  if (dither !== "none" && dither !== "floyd-steinberg") {
    throw gifError('dither must be "none" or "floyd-steinberg"');
  }
  return { maxColors, loop, paletteMode, dither };
}

function isFrameList(image: PixelBuffer | readonly GifFrame[]): image is readonly GifFrame[] {
  return Array.isArray(image);
}

function framesFromInput(image: PixelBuffer | readonly GifFrame[]): {
  readonly frames: readonly GifFrame[];
  readonly still: boolean;
} {
  if (isFrameList(image)) {
    if (image.length === 0) {
      throw gifError("needs at least one frame");
    }
    return { frames: image, still: false };
  }
  return { frames: [image], still: true };
}

function tableForPixels(
  data: Uint8Array,
  gct: ColorTable,
  useLocal: boolean,
  maxColors: number,
): { readonly table: ColorTable; readonly local: boolean } {
  if (!useLocal || canUseTable(data, gct)) {
    return { table: gct, local: false };
  }
  const frameTrans = hasTransparentPixels(data);
  const opaque = quantizeOpaqueColors([data], frameTrans ? maxColors - 1 : maxColors);
  return { table: makeColorTable(opaque, frameTrans), local: true };
}

type Rect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

type PlannedFrame = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly disposal: number;
};

function pixelTransparent(data: Uint8Array, i: number): boolean {
  return isTransparentAlpha(data[i + 3] ?? 0);
}

function pixelsMatch(a: Uint8Array, b: Uint8Array, i: number): boolean {
  const aTrans = pixelTransparent(a, i);
  const bTrans = pixelTransparent(b, i);
  if (aTrans && bTrans) {
    return true;
  }
  if (aTrans || bTrans) {
    return false;
  }
  return a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2];
}

function buffersMatch(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const n = (a.length / 4) | 0;
  for (let p = 0; p < n; p++) {
    if (!pixelsMatch(a, b, p * 4)) {
      return false;
    }
  }
  return true;
}

function diffBounds(a: Uint8Array, b: Uint8Array, width: number, height: number): Rect | undefined {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixelsMatch(a, b, (y * width + x) * 4)) {
        continue;
      }
      if (x < left) {
        left = x;
      }
      if (x > right) {
        right = x;
      }
      if (y < top) {
        top = y;
      }
      if (y > bottom) {
        bottom = y;
      }
    }
  }
  if (right < 0) {
    return undefined;
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function mustClearBounds(
  current: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
): Rect | undefined {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixelTransparent(current, i) || !pixelTransparent(next, i)) {
        continue;
      }
      if (x < left) {
        left = x;
      }
      if (x > right) {
        right = x;
      }
      if (y < top) {
        top = y;
      }
      if (y > bottom) {
        bottom = y;
      }
    }
  }
  if (right < 0) {
    return undefined;
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: right - left, height: bottom - top };
}

function rectArea(rect: Rect | undefined): number {
  if (rect === undefined) {
    return 0;
  }
  return rect.width * rect.height;
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.min(width - 1, rect.left));
  const top = Math.max(0, Math.min(height - 1, rect.top));
  const right = Math.max(left + 1, Math.min(width, rect.left + rect.width));
  const bottom = Math.max(top + 1, Math.min(height, rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function clearRect(
  canvas: Uint8Array,
  canvasW: number,
  canvasH: number,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(canvasW, left + width);
  const y1 = Math.min(canvasH, top + height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * canvasW + x) * 4;
      canvas[i] = 0;
      canvas[i + 1] = 0;
      canvas[i + 2] = 0;
      canvas[i + 3] = 0;
    }
  }
}

function rgbaFromIndexes(indexes: Uint8Array, table: ColorTable): Uint8Array {
  const n = indexes.length;
  const out = new Uint8Array(n * 4);
  const { rgb, transparentIndex } = table;
  for (let p = 0; p < n; p++) {
    const idx = indexes[p] ?? 0;
    if (transparentIndex !== undefined && idx === transparentIndex) {
      continue;
    }
    const off = idx * 3;
    const i = p * 4;
    out[i] = rgb[off] ?? 0;
    out[i + 1] = rgb[off + 1] ?? 0;
    out[i + 2] = rgb[off + 2] ?? 0;
    out[i + 3] = 255;
  }
  return out;
}

function cropWithSkip(
  desired: Uint8Array,
  canvas: Uint8Array,
  canvasW: number,
  rect: Rect,
): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const cx = rect.left + x;
      const cy = rect.top + y;
      const src = (cy * canvasW + cx) * 4;
      const dst = (y * rect.width + x) * 4;
      if (pixelsMatch(desired, canvas, src)) {
        continue;
      }
      out[dst] = desired[src] ?? 0;
      out[dst + 1] = desired[src + 1] ?? 0;
      out[dst + 2] = desired[src + 2] ?? 0;
      out[dst + 3] = desired[src + 3] ?? 0;
    }
  }
  return out;
}

function mergeDuplicateFrames(
  desired: readonly Uint8Array[],
  delays: readonly number[],
): { readonly desired: Uint8Array[]; readonly delays: number[] } {
  const outDesired: Uint8Array[] = [];
  const outDelays: number[] = [];
  for (let i = 0; i < desired.length; i++) {
    const data = desired[i];
    const delay = delays[i] ?? 10;
    if (data === undefined) {
      continue;
    }
    const prev = outDesired[outDesired.length - 1];
    const prevDelay = outDelays[outDelays.length - 1];
    if (prev !== undefined && prevDelay !== undefined && buffersMatch(prev, data)) {
      if (prevDelay + delay <= MAX_DELAY_CS) {
        outDelays[outDelays.length - 1] = prevDelay + delay;
        continue;
      }
    }
    outDesired.push(data);
    outDelays.push(delay);
  }
  return { desired: outDesired, delays: outDelays };
}

function planAnimation(
  desired: readonly Uint8Array[],
  width: number,
  height: number,
): PlannedFrame[] {
  const canvas = new Uint8Array(width * height * 4);
  const planned: PlannedFrame[] = [];
  for (let i = 0; i < desired.length; i++) {
    const target = desired[i];
    if (target === undefined) {
      continue;
    }
    const next = desired[i + 1];
    const leaveRect = clampRect(
      diffBounds(canvas, target, width, height) ?? { left: 0, top: 0, width: 1, height: 1 },
      width,
      height,
    );
    let rect = leaveRect;
    let disposal = 1;
    if (next !== undefined) {
      const clear = mustClearBounds(target, next, width, height);
      const validLeave = clear === undefined;
      const nextLeave = diffBounds(target, next, width, height);
      let restoreRect = leaveRect;
      if (clear !== undefined) {
        restoreRect = clampRect(unionRect(leaveRect, clear), width, height);
      }
      const afterRestore = target.slice();
      clearRect(
        afterRestore,
        width,
        height,
        restoreRect.left,
        restoreRect.top,
        restoreRect.width,
        restoreRect.height,
      );
      const nextRestore = diffBounds(afterRestore, next, width, height);
      if (!validLeave || rectArea(nextRestore) < rectArea(nextLeave)) {
        rect = restoreRect;
        disposal = 2;
      }
    }
    planned.push({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      disposal,
    });
    canvas.set(target);
    if (disposal === 2) {
      clearRect(canvas, width, height, rect.left, rect.top, rect.width, rect.height);
    }
  }
  return planned;
}

function writeImage(
  sink: ByteSink,
  left: number,
  top: number,
  width: number,
  height: number,
  indexes: Uint8Array,
  table: ColorTable,
  local: boolean,
): void {
  sink.u8(0x2c);
  sink.u16(left);
  sink.u16(top);
  sink.u16(width);
  sink.u16(height);
  if (local) {
    sink.u8(0x80 | (table.bits - 1));
    sink.bytes(table.rgb);
  } else {
    sink.u8(0);
  }
  const minCodeSize = Math.max(2, table.bits);
  sink.u8(minCodeSize);
  writeSubBlocks(sink, encodeLzw(minCodeSize, indexes));
}

function gctNeedsTransparency(
  frameData: readonly Uint8Array[],
  animate: boolean,
  maxColors: number,
): boolean {
  let anyTransparent = false;
  let unique = 0;
  const seen = new Map<number, number>();
  for (let b = 0; b < frameData.length; b++) {
    const data = frameData[b];
    if (data === undefined) {
      continue;
    }
    if (hasTransparentPixels(data)) {
      anyTransparent = true;
    }
    const colors = uniqueOpaqueColors(data);
    for (let i = 0; i < colors.length; i++) {
      const key = colors[i];
      if (key === undefined || seen.has(key)) {
        continue;
      }
      seen.set(key, unique);
      unique += 1;
    }
  }
  if (anyTransparent) {
    return true;
  }
  return animate && unique < maxColors;
}

/** GIF89a encode: RGBA pixels in, GIF bytes out. */
export function encodeGif(
  image: PixelBuffer | readonly GifFrame[],
  options?: GifEncodeOptions,
): Uint8Array {
  const { maxColors, loop, paletteMode, dither } = validateEncodeOptions(options);
  const { frames, still } = framesFromInput(image);
  const first = frames[0];
  if (first === undefined) {
    throw gifError("needs at least one frame");
  }
  assertPixelBuffer(first, "frame 0");
  optionalUint(first.delay, "delay", MAX_DELAY_MS);
  optionalUint(first.disposal, "disposal", 3);
  const width = first.width;
  const height = first.height;
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    assertPixelBuffer(frame, `frame ${i}`);
    optionalUint(frame.delay, "delay", MAX_DELAY_MS);
    optionalUint(frame.disposal, "disposal", 3);
    if (frame.width !== width || frame.height !== height) {
      throw gifError("all GIF frames must match the first frame size");
    }
  }

  const animate = frames.length > 1;
  const useLocal = paletteMode === "local" && animate;
  const frameData: Uint8Array[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    frameData.push(frame.data);
  }

  const gctBuffers = useLocal ? [first.data] : frameData;
  const reserveTrans = gctNeedsTransparency(gctBuffers, animate, maxColors);
  const gctOpaque = quantizeOpaqueColors(gctBuffers, reserveTrans ? maxColors - 1 : maxColors);
  const gct = makeColorTable(gctOpaque, reserveTrans);
  const packedLsd = 0x80 | ((gct.bits - 1) << 4) | (gct.bits - 1);

  const sink = new ByteSink();
  sink.bytes(GIF89A);
  sink.u16(width);
  sink.u16(height);
  sink.u8(packedLsd);
  sink.u8(gct.backgroundIndex);
  sink.u8(0);
  sink.bytes(gct.rgb);

  if (loop !== undefined) {
    writeNetscape(sink, loop);
  }

  if (!animate) {
    const frame = first;
    const delayCs = msToCentiseconds(frame.delay ?? 100);
    const disposal = frame.disposal ?? 2;
    const { table, local } = tableForPixels(frame.data, gct, false, maxColors);
    const indexes = indexesFromRgba(frame.data, width, height, table, dither);
    const trans = hasTransparentPixels(frame.data) ? table.transparentIndex : undefined;
    if (still) {
      if (trans !== undefined) {
        writeGce(sink, 0, 1, trans);
      }
    } else {
      writeGce(sink, delayCs, disposal, trans);
    }
    writeImage(sink, 0, 0, width, height, indexes, table, local);
    sink.u8(0x3b);
    return sink.take();
  }

  const snapped: Uint8Array[] = [];
  const delays: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    const delayCs = msToCentiseconds(frame.delay ?? 100);
    const { table } = tableForPixels(frame.data, gct, useLocal, maxColors);
    const indexes = indexesFromRgba(frame.data, width, height, table, dither);
    snapped.push(rgbaFromIndexes(indexes, table));
    delays.push(delayCs);
  }

  const merged = mergeDuplicateFrames(snapped, delays);
  const planned = planAnimation(merged.desired, width, height);
  const canvas = new Uint8Array(width * height * 4);
  for (let i = 0; i < planned.length; i++) {
    const plan = planned[i];
    const target = merged.desired[i];
    const delay = merged.delays[i] ?? 10;
    if (plan === undefined || target === undefined) {
      continue;
    }
    const crop = cropWithSkip(target, canvas, width, plan);
    const { table, local } = tableForPixels(crop, gct, useLocal, maxColors);
    const indexes = indexesFromRgba(crop, plan.width, plan.height, table, "none");
    const trans = hasTransparentPixels(crop) ? table.transparentIndex : undefined;
    writeGce(sink, delay, plan.disposal, trans);
    writeImage(sink, plan.left, plan.top, plan.width, plan.height, indexes, table, local);
    canvas.set(target);
    if (plan.disposal === 2) {
      clearRect(canvas, width, height, plan.left, plan.top, plan.width, plan.height);
    }
  }

  sink.u8(0x3b);
  return sink.take();
}
