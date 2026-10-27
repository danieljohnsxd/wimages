import { DEFAULT_MAX_PIXELS } from "../limits.ts";
import type { PixelBuffer } from "../pixels.ts";
import {
  concatBytes,
  createChunk,
  hasPngSignature,
  parsePngChunks,
  PNG_SIGNATURE,
  readUint16BE,
  readUint32BE,
  writeUint16BE,
  writeUint32BE,
  type PngChunk,
} from "./chunk.ts";
import { analyzeRgba, type ColorAnalysis, type PngColorKind } from "./color.ts";
import {
  applyPngOrientation,
  checkPngDecodeBudget,
  concatIdat,
  decodePngZlibToRgba,
  parsePngIhdr,
  pngColorState,
  resolvePngOrientation,
  type PngDecodeOptions,
  type PngIhdrInfo,
} from "./decode.ts";
import { buildIhdr, COLOR_TYPE_CODE, encodePngPayload, resolvePngEffort } from "./encode.ts";
import { pngError, pngRangeError } from "./error.ts";

export type ApngFrame = {
  readonly image: PixelBuffer;
  /** Delay in milliseconds (not GIF centiseconds). Default 100. */
  readonly delay?: number;
};

export type ApngDecodeResult = {
  readonly width: number;
  readonly height: number;
  readonly frames: PixelBuffer[];
  /** Milliseconds per frame. */
  readonly delays: number[];
  /** 0 = forever; undefined when not animated */
  readonly loop: number | undefined;
};

export type ApngEncodeOptions = {
  /**
   * Play count written as acTL `num_plays`.
   * `undefined` or `1`: play once (`num_plays = 1`).
   * `0`: loop forever.
   * Any other integer n: play n times.
   */
  readonly loop?: number;
  readonly effort?: "fast" | "strong";
};

const DISPOSE_NONE = 0;
const DISPOSE_BACKGROUND = 1;
const DISPOSE_PREVIOUS = 2;
const BLEND_SOURCE = 0;
const BLEND_OVER = 1;
const PNG_UINT31 = 0x7fffffff;

type FcTl = {
  readonly seq: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly delayNum: number;
  readonly delayDen: number;
  readonly dispose: number;
  readonly blend: number;
};

type PreparedFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  blend: number;
  dispose: number;
  delay: number;
};

/** True when `acTL` appears before `IDAT` and `num_frames > 1`. */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  if (!hasPngSignature(bytes)) {
    return false;
  }
  try {
    const chunks = parsePngChunks(bytes);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        continue;
      }
      if (chunk.type === "IDAT") {
        return false;
      }
      if (chunk.type === "acTL") {
        if (chunk.data.length < 4) {
          return false;
        }
        return readUint32BE(chunk.data, 0) > 1;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function orientResult(
  result: ApngDecodeResult,
  chunks: readonly PngChunk[],
  mode: NonNullable<PngDecodeOptions["orientation"]>,
): ApngDecodeResult {
  if (mode === "ignore") {
    return result;
  }
  const frames = result.frames.map((frame) => applyPngOrientation(frame, chunks, mode));
  const first = frames[0];
  if (first === undefined) {
    return result;
  }
  return {
    width: first.width,
    height: first.height,
    frames,
    delays: result.delays,
    loop: result.loop,
  };
}

/**
 * Decode an APNG to full-canvas RGBA frames, composited with dispose/blend.
 * A still PNG returns one frame and `loop: undefined`.
 * eXIf orientation is applied to every composited frame (same as `decodePng`).
 */
export function decodeApng(bytes: Uint8Array, options?: PngDecodeOptions): ApngDecodeResult {
  const orientation = resolvePngOrientation(options?.orientation);
  const chunks = parsePngChunks(bytes);
  const ihdrChunk = chunks[0];
  if (ihdrChunk === undefined || ihdrChunk.type !== "IHDR") {
    throw pngError("must start with a 13-byte IHDR");
  }
  const header = parsePngIhdr(ihdrChunk.data);
  checkPngDecodeBudget(header, options?.maxPixels);
  const color = pngColorState(chunks, header.colorType);
  const parsed = parseAnimation(chunks, header, options?.maxPixels);

  if (parsed === undefined) {
    const data = decodePngZlibToRgba(
      concatIdat(chunks),
      header.width,
      header.height,
      header.bitDepth,
      header.colorType,
      header.interlace,
      color,
    );
    return orientResult(
      {
        width: header.width,
        height: header.height,
        frames: [{ width: header.width, height: header.height, data }],
        delays: [0],
        loop: undefined,
      },
      chunks,
      orientation,
    );
  }

  const { width, height } = header;
  const canvas = new Uint8Array(width * height * 4);
  const frames: PixelBuffer[] = [];
  const delays: number[] = [];

  for (let i = 0; i < parsed.frames.length; i++) {
    const frame = parsed.frames[i];
    if (frame === undefined) {
      continue;
    }
    const compressed = concatBytes(frame.data);
    const patch = decodePngZlibToRgba(
      compressed,
      frame.width,
      frame.height,
      header.bitDepth,
      header.colorType,
      header.interlace,
      color,
    );

    let dispose = frame.dispose;
    if (i === 0 && dispose === DISPOSE_PREVIOUS) {
      dispose = DISPOSE_BACKGROUND;
    }
    const saved = dispose === DISPOSE_PREVIOUS ? canvas.slice() : undefined;

    if (frame.blend === BLEND_SOURCE) {
      blitSource(canvas, width, height, patch, frame.width, frame.height, frame.x, frame.y);
    } else if (frame.blend === BLEND_OVER) {
      blitOver(canvas, width, height, patch, frame.width, frame.height, frame.x, frame.y);
    } else {
      throw pngError(`invalid blend_op ${frame.blend}`);
    }

    frames.push({ width, height, data: canvas.slice() });
    delays.push(delayMs(frame.delayNum, frame.delayDen));

    if (dispose === DISPOSE_BACKGROUND) {
      clearRect(canvas, width, height, frame.x, frame.y, frame.width, frame.height);
    } else if (dispose === DISPOSE_PREVIOUS) {
      if (saved !== undefined) {
        canvas.set(saved);
      } else {
        clearRect(canvas, width, height, frame.x, frame.y, frame.width, frame.height);
      }
    } else if (dispose !== DISPOSE_NONE) {
      throw pngError(`invalid dispose_op ${frame.dispose}`);
    }
  }

  return orientResult(
    {
      width,
      height,
      frames,
      delays,
      loop: frames.length > 1 ? parsed.numPlays : undefined,
    },
    chunks,
    orientation,
  );
}

function resolveLoop(loop: number | undefined): number {
  if (loop === undefined || loop === 1) {
    return 1;
  }
  if (!Number.isInteger(loop) || loop < 0 || loop > PNG_UINT31) {
    throw pngRangeError(`loop must be an integer from 0 to ${PNG_UINT31}`);
  }
  return loop;
}

/** APNG encode: full-canvas RGBA frames in, APNG bytes out. */
export function encodeApng(frames: readonly ApngFrame[], options?: ApngEncodeOptions): Uint8Array {
  const effort = resolvePngEffort(options?.effort);
  const loop = resolveLoop(options?.loop);
  if (frames.length === 0) {
    throw pngRangeError("needs at least one frame");
  }
  const first = frames[0];
  if (first === undefined) {
    throw pngRangeError("needs at least one frame");
  }
  assertPixelBuffer(first.image, "frame 0");
  const width = first.image.width;
  const height = first.image.height;
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    assertPixelBuffer(frame.image, `frame ${i}`);
    if (frame.image.width !== width || frame.image.height !== height) {
      throw pngRangeError("all frames must match the first frame size");
    }
  }
  const prepared = prepareFrames(frames, width, height);
  const analysis = sharedAnalysis(prepared);
  const parts: Uint8Array[] = [
    PNG_SIGNATURE,
    createChunk(
      "IHDR",
      buildIhdr(width, height, analysis.bitDepth, COLOR_TYPE_CODE[analysis.kind]),
    ),
  ];

  let seq = 0;
  let plte: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  for (let i = 0; i < prepared.length; i++) {
    const frame = prepared[i];
    if (frame === undefined) {
      continue;
    }
    const payload = encodePngPayload(frame.pixels, frame.width, frame.height, analysis, effort);
    if (i === 0) {
      plte = payload.plte;
      trns = payload.trns;
      if (plte !== undefined) {
        parts.push(createChunk("PLTE", plte));
      }
      if (trns !== undefined) {
        parts.push(createChunk("tRNS", trns));
      }
      parts.push(createChunk("acTL", makeActl(prepared.length, loop)));
    }
    parts.push(
      createChunk(
        "fcTL",
        makeFctl(
          seq,
          frame.width,
          frame.height,
          frame.x,
          frame.y,
          frame.delay,
          frame.dispose,
          frame.blend,
        ),
      ),
    );
    seq += 1;
    if (i === 0) {
      parts.push(createChunk("IDAT", payload.compressed));
    } else {
      parts.push(createChunk("fdAT", makeFdat(seq, payload.compressed)));
      seq += 1;
    }
  }
  parts.push(createChunk("IEND", new Uint8Array(0)));
  return concatBytes(parts);
}

function parseAnimation(
  chunks: readonly PngChunk[],
  header: PngIhdrInfo,
  maxPixels: number | undefined,
):
  | {
      readonly numPlays: number;
      readonly frames: Array<
        FcTl & {
          readonly data: Uint8Array[];
        }
      >;
    }
  | undefined {
  let actl: { readonly numFrames: number; readonly numPlays: number } | undefined;
  let seenIdat = false;
  let expectedSeq = 0;
  const idatParts: Uint8Array[] = [];
  const frames: Array<FcTl & { readonly data: Uint8Array[]; fromIdat: boolean }> = [];
  let current: (FcTl & { readonly data: Uint8Array[]; fromIdat: boolean }) | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) {
      continue;
    }
    if (chunk.type === "acTL") {
      if (seenIdat || actl !== undefined) {
        continue;
      }
      actl = parseActl(chunk.data);
      checkAnimationBudget(header.width, header.height, actl.numFrames, maxPixels);
      continue;
    }
    if (chunk.type === "fcTL") {
      const fctl = parseFctl(chunk.data);
      if (fctl.seq !== expectedSeq) {
        throw pngError(`invalid sequence number (expected ${expectedSeq}, got ${fctl.seq})`);
      }
      expectedSeq += 1;
      if (!seenIdat && frames.length > 0) {
        throw pngError("only one fcTL is allowed before IDAT");
      }
      validateFrameRect(header, fctl, !seenIdat);
      const rec = { ...fctl, data: [] as Uint8Array[], fromIdat: !seenIdat };
      frames.push(rec);
      current = rec;
      continue;
    }
    if (chunk.type === "IDAT") {
      seenIdat = true;
      idatParts.push(chunk.data);
      continue;
    }
    if (chunk.type === "fdAT") {
      if (chunk.data.length < 4) {
        throw pngError("truncated fdAT");
      }
      const seq = readUint32BE(chunk.data, 0);
      if (seq !== expectedSeq) {
        throw pngError(`invalid sequence number (expected ${expectedSeq}, got ${seq})`);
      }
      expectedSeq += 1;
      if (current === undefined || current.fromIdat) {
        throw pngError("fdAT without a matching fcTL");
      }
      current.data.push(chunk.data.subarray(4));
    }
  }

  if (actl === undefined) {
    return undefined;
  }
  if (idatParts.length === 0) {
    throw pngError("no IDAT data");
  }

  const first = frames[0];
  if (first !== undefined && first.fromIdat) {
    // A loop, not push(...spread): a file split into >100k IDAT chunks would
    // overflow the argument limit (RangeError) instead of decoding.
    for (const part of idatParts) {
      first.data.push(part);
    }
  }

  if (frames.length !== actl.numFrames) {
    throw pngError(
      `acTL num_frames (${actl.numFrames}) does not match fcTL count (${frames.length})`,
    );
  }
  if (frames.length === 0) {
    throw pngError("animation has no frames");
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined || frame.data.length === 0) {
      throw pngError("frame is missing image data");
    }
  }
  return { numPlays: actl.numPlays, frames };
}

function parseActl(data: Uint8Array): { readonly numFrames: number; readonly numPlays: number } {
  if (data.length !== 8) {
    throw pngError("acTL must be 8 bytes");
  }
  const numFrames = readUint32BE(data, 0);
  const numPlays = readUint32BE(data, 4);
  if (numFrames < 1 || numFrames > PNG_UINT31) {
    throw pngError("acTL num_frames must be at least 1");
  }
  if (numPlays > PNG_UINT31) {
    throw pngError("acTL num_plays is invalid");
  }
  return { numFrames, numPlays };
}

function parseFctl(data: Uint8Array): FcTl {
  if (data.length !== 26) {
    throw pngError("fcTL must be 26 bytes");
  }
  return {
    seq: readUint32BE(data, 0),
    width: readUint32BE(data, 4),
    height: readUint32BE(data, 8),
    x: readUint32BE(data, 12),
    y: readUint32BE(data, 16),
    delayNum: readUint16BE(data, 20),
    delayDen: readUint16BE(data, 22),
    dispose: data[24] ?? 0,
    blend: data[25] ?? 0,
  };
}

function checkAnimationBudget(
  width: number,
  height: number,
  frameCount: number,
  maxPixels: number | undefined,
): void {
  const limit = maxPixels ?? DEFAULT_MAX_PIXELS;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw pngError("maxPixels must be a positive number");
  }
  const per = width * height;
  if (frameCount > 0 && per > Math.floor(limit / frameCount)) {
    const total = per * frameCount;
    const totalText = Number.isSafeInteger(total) ? `${total}` : `${frameCount}×${per}`;
    throw pngError(
      `animation of ${frameCount} frames × ${width}×${height} exceeds maxPixels (${totalText} > ${limit}); raise maxPixels or use decodePng for the first frame`,
    );
  }
}

function validateFrameRect(header: PngIhdrInfo, fctl: FcTl, defaultImage: boolean): void {
  if (fctl.width < 1 || fctl.height < 1) {
    throw pngError(`invalid dimensions ${fctl.width}x${fctl.height}`);
  }
  if (fctl.x > PNG_UINT31 || fctl.y > PNG_UINT31) {
    throw pngError("fcTL rectangle is outside the canvas");
  }
  if (fctl.x + fctl.width > header.width || fctl.y + fctl.height > header.height) {
    throw pngError("fcTL rectangle is outside the canvas");
  }
  if (
    defaultImage &&
    (fctl.x !== 0 || fctl.y !== 0 || fctl.width !== header.width || fctl.height !== header.height)
  ) {
    throw pngError("default-image fcTL must match IHDR");
  }
}

function delayMs(num: number, den: number): number {
  const denom = den === 0 ? 100 : den;
  return Math.round((num * 1000) / denom);
}

function blitSource(
  canvas: Uint8Array,
  canvasW: number,
  canvasH: number,
  patch: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
): void {
  for (let y = 0; y < height; y++) {
    const cy = top + y;
    if (cy < 0 || cy >= canvasH) {
      continue;
    }
    for (let x = 0; x < width; x++) {
      const cx = left + x;
      if (cx < 0 || cx >= canvasW) {
        continue;
      }
      const si = (y * width + x) * 4;
      const di = (cy * canvasW + cx) * 4;
      canvas[di] = patch[si] ?? 0;
      canvas[di + 1] = patch[si + 1] ?? 0;
      canvas[di + 2] = patch[si + 2] ?? 0;
      canvas[di + 3] = patch[si + 3] ?? 0;
    }
  }
}

function blitOver(
  canvas: Uint8Array,
  canvasW: number,
  canvasH: number,
  patch: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
): void {
  for (let y = 0; y < height; y++) {
    const cy = top + y;
    if (cy < 0 || cy >= canvasH) {
      continue;
    }
    for (let x = 0; x < width; x++) {
      const cx = left + x;
      if (cx < 0 || cx >= canvasW) {
        continue;
      }
      const si = (y * width + x) * 4;
      const di = (cy * canvasW + cx) * 4;
      blendOverPixel(
        canvas,
        di,
        patch[si] ?? 0,
        patch[si + 1] ?? 0,
        patch[si + 2] ?? 0,
        patch[si + 3] ?? 0,
      );
    }
  }
}

/** Porter-Duff source-over on unpremultiplied 8-bit RGBA (UPNG / browser formula). */
function blendOverPixel(
  dst: Uint8Array,
  di: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
): void {
  if (sa === 0) {
    return;
  }
  if (sa === 255) {
    dst[di] = sr;
    dst[di + 1] = sg;
    dst[di + 2] = sb;
    dst[di + 3] = 255;
    return;
  }
  const da = dst[di + 3] ?? 0;
  if (da === 0) {
    dst[di] = sr;
    dst[di + 1] = sg;
    dst[di + 2] = sb;
    dst[di + 3] = sa;
    return;
  }
  const fa = sa / 255;
  const ba = da / 255;
  const ifa = 1 - fa;
  const oa = fa + ba * ifa;
  const ioa = oa === 0 ? 0 : 1 / oa;
  dst[di] = Math.round((sr * fa + (dst[di] ?? 0) * ba * ifa) * ioa);
  dst[di + 1] = Math.round((sg * fa + (dst[di + 1] ?? 0) * ba * ifa) * ioa);
  dst[di + 2] = Math.round((sb * fa + (dst[di + 2] ?? 0) * ba * ifa) * ioa);
  dst[di + 3] = Math.round(255 * oa);
}

function overEqualsTarget(
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  dr: number,
  dg: number,
  db: number,
  da: number,
): boolean {
  const tmp = new Uint8Array([dr, dg, db, da]);
  blendOverPixel(tmp, 0, sr, sg, sb, sa);
  return tmp[0] === sr && tmp[1] === sg && tmp[2] === sb && tmp[3] === sa;
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
    canvas.fill(0, (y * canvasW + x0) * 4, (y * canvasW + x1) * 4);
  }
}

function assertPixelBuffer(image: PixelBuffer, label: string): void {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw pngRangeError(`${label}: width and height must be positive integers`);
  }
  if (data.length !== width * height * 4) {
    throw pngRangeError(`${label}: RGBA data length must equal width * height * 4`);
  }
}

function frameDelay(delay: number | undefined): number {
  const value = delay ?? 100;
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw pngRangeError("delay must be an integer from 0 to 65535");
  }
  return value;
}

function pixelsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function mergeSourceFrames(
  frames: readonly ApngFrame[],
): Array<{ readonly data: Uint8Array; readonly delay: number }> {
  const merged: Array<{ data: Uint8Array; delay: number }> = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    const delay = frameDelay(frame.delay);
    const last = merged[merged.length - 1];
    if (last !== undefined && pixelsEqual(last.data, frame.image.data)) {
      last.delay += delay;
      continue;
    }
    merged.push({ data: frame.image.data, delay });
  }
  return merged;
}

type Dirty = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

function dirtyRect(a: Uint8Array, b: Uint8Array, width: number, height: number): Dirty | undefined {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (
        a[i] !== b[i] ||
        a[i + 1] !== b[i + 1] ||
        a[i + 2] !== b[i + 2] ||
        a[i + 3] !== b[i + 3]
      ) {
        if (x < x0) {
          x0 = x;
        }
        if (x > x1) {
          x1 = x;
        }
        if (y < y0) {
          y0 = y;
        }
        if (y > y1) {
          y1 = y;
        }
      }
    }
  }
  if (x1 < 0) {
    return undefined;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function extractRect(
  src: Uint8Array,
  srcW: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const si = ((y + row) * srcW + x) * 4;
    out.set(src.subarray(si, si + w * 4), row * w * 4);
  }
  return out;
}

function prepareDiff(
  target: Uint8Array,
  before: Uint8Array,
  srcW: number,
  rect: Dirty,
): Uint8Array {
  const out = new Uint8Array(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row++) {
    for (let col = 0; col < rect.w; col++) {
      const si = ((rect.y + row) * srcW + (rect.x + col)) * 4;
      const di = (row * rect.w + col) * 4;
      if (
        target[si] === before[si] &&
        target[si + 1] === before[si + 1] &&
        target[si + 2] === before[si + 2] &&
        target[si + 3] === before[si + 3]
      ) {
        continue;
      }
      out[di] = target[si] ?? 0;
      out[di + 1] = target[si + 1] ?? 0;
      out[di + 2] = target[si + 2] ?? 0;
      out[di + 3] = target[si + 3] ?? 0;
    }
  }
  return out;
}

function canBlendOver(target: Uint8Array, before: Uint8Array, srcW: number, rect: Dirty): boolean {
  for (let row = 0; row < rect.h; row++) {
    for (let col = 0; col < rect.w; col++) {
      const i = ((rect.y + row) * srcW + (rect.x + col)) * 4;
      const tr = target[i] ?? 0;
      const tg = target[i + 1] ?? 0;
      const tb = target[i + 2] ?? 0;
      const ta = target[i + 3] ?? 0;
      const br = before[i] ?? 0;
      const bg = before[i + 1] ?? 0;
      const bb = before[i + 2] ?? 0;
      const ba = before[i + 3] ?? 0;
      if (tr === br && tg === bg && tb === bb && ta === ba) {
        continue;
      }
      if (!overEqualsTarget(tr, tg, tb, ta, br, bg, bb, ba)) {
        return false;
      }
    }
  }
  return true;
}

function dummyRect(): Dirty {
  return { x: 0, y: 0, w: 1, h: 1 };
}

function prepareFrames(
  frames: readonly ApngFrame[],
  width: number,
  height: number,
): PreparedFrame[] {
  const sources = mergeSourceFrames(frames);
  const out: PreparedFrame[] = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (src === undefined) {
      continue;
    }
    if (i === 0) {
      out.push({
        x: 0,
        y: 0,
        width,
        height,
        pixels: src.data.slice(),
        blend: BLEND_SOURCE,
        dispose: DISPOSE_NONE,
        delay: src.delay,
      });
      continue;
    }
    const prev = out[i - 1];
    const prevSrc = sources[i - 1];
    if (prev === undefined || prevSrc === undefined) {
      continue;
    }

    const noneDirty = dirtyRect(src.data, prevSrc.data, width, height);
    const bgCanvas = prevSrc.data.slice();
    clearRect(bgCanvas, width, height, prev.x, prev.y, prev.width, prev.height);
    const bgDirty = dirtyRect(src.data, bgCanvas, width, height);
    const noneArea = noneDirty === undefined ? 0 : noneDirty.w * noneDirty.h;
    const bgArea = bgDirty === undefined ? 0 : bgDirty.w * bgDirty.h;
    const useBg = bgArea < noneArea;
    if (useBg) {
      prev.dispose = DISPOSE_BACKGROUND;
    }
    const before = useBg ? bgCanvas : prevSrc.data;
    const rect = (useBg ? bgDirty : noneDirty) ?? dummyRect();
    const blendable = canBlendOver(src.data, before, width, rect);
    if (blendable) {
      out.push({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        pixels: prepareDiff(src.data, before, width, rect),
        blend: BLEND_OVER,
        dispose: DISPOSE_NONE,
        delay: src.delay,
      });
    } else {
      out.push({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        pixels: extractRect(src.data, width, rect.x, rect.y, rect.w, rect.h),
        blend: BLEND_SOURCE,
        dispose: DISPOSE_NONE,
        delay: src.delay,
      });
    }
  }
  return out;
}

function sharedAnalysis(frames: readonly PreparedFrame[]): ColorAnalysis {
  let allGray = true;
  let hasAlpha = false;
  let total = 0;
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    if (frame === undefined) {
      continue;
    }
    const n = frame.width * frame.height;
    total += n;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const r = frame.pixels[i] ?? 0;
      const g = frame.pixels[i + 1] ?? 0;
      const b = frame.pixels[i + 2] ?? 0;
      const a = frame.pixels[i + 3] ?? 0;
      if (r !== g || g !== b) {
        allGray = false;
      }
      if (a !== 255) {
        hasAlpha = true;
      }
    }
  }
  if (total === 0) {
    return { kind: "rgba", bitDepth: 8, palette: [], hasAlpha: true };
  }
  const combined = new Uint8Array(total * 4);
  let o = 0;
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    if (frame === undefined) {
      continue;
    }
    combined.set(frame.pixels, o);
    o += frame.pixels.length;
  }
  const kind: PngColorKind = allGray
    ? hasAlpha
      ? "gray-alpha"
      : "gray"
    : hasAlpha
      ? "rgba"
      : "rgb";
  return analyzeRgba(combined, total, 1, kind);
}

function makeActl(numFrames: number, numPlays: number): Uint8Array {
  const data = new Uint8Array(8);
  writeUint32BE(data, 0, numFrames);
  writeUint32BE(data, 4, numPlays);
  return data;
}

function encodeDelay(ms: number): { readonly num: number; readonly den: number } {
  if (ms <= 65535) {
    return { num: ms, den: 1000 };
  }
  return { num: Math.min(65535, Math.round(ms / 10)), den: 100 };
}

function makeFctl(
  seq: number,
  width: number,
  height: number,
  x: number,
  y: number,
  delay: number,
  dispose: number,
  blend: number,
): Uint8Array {
  const data = new Uint8Array(26);
  const { num, den } = encodeDelay(delay);
  writeUint32BE(data, 0, seq);
  writeUint32BE(data, 4, width);
  writeUint32BE(data, 8, height);
  writeUint32BE(data, 12, x);
  writeUint32BE(data, 16, y);
  writeUint16BE(data, 20, num);
  writeUint16BE(data, 22, den);
  data[24] = dispose;
  data[25] = blend;
  return data;
}

function makeFdat(seq: number, zlib: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + zlib.length);
  writeUint32BE(data, 0, seq);
  data.set(zlib, 4);
  return data;
}
