import { checkDimensions, DEFAULT_MAX_PIXELS, type DecodeLimits } from "../limits.ts";
import type { PixelBuffer } from "../pixels.ts";
import { gifError } from "./error.ts";
import { decodeLzw } from "./lzw.ts";

export type GifDecodeResult = {
  readonly width: number;
  readonly height: number;
  readonly frames: PixelBuffer[];
  /**
   * Per-frame delay in milliseconds (GIF stores centiseconds; this is × 10).
   * `0` stays `0`. Browsers treat delays ≤ 10 ms as 100 ms; this codec reports
   * the raw value and the product layer normalizes.
   */
  readonly delays: number[];
  /**
   * NETSCAPE loop count. `undefined` when the file has no NETSCAPE (or ANIMEXTS)
   * block (play once); `0` means loop forever; `n` means loop `n` times.
   */
  readonly loop: number | undefined;
};

const GIF_HEADER_LEN = 6;

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    n += parts[i]?.length ?? 0;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) {
      continue;
    }
    out.set(part, o);
    o += part.length;
  }
  return out;
}

class ByteReader {
  private readonly data: Uint8Array;
  private pos: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.pos = 0;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  readByte(): number {
    const b = this.data[this.pos];
    if (b === undefined) {
      throw gifError("unexpected end of data");
    }
    this.pos += 1;
    return b;
  }

  readUint16LE(): number {
    const lo = this.readByte();
    const hi = this.readByte();
    return lo | (hi << 8);
  }

  readBytes(count: number): Uint8Array {
    if (count < 0 || this.pos + count > this.data.length) {
      throw gifError("unexpected end of data");
    }
    const slice = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  skip(count: number): void {
    if (count < 0 || this.pos + count > this.data.length) {
      throw gifError("unexpected end of data");
    }
    this.pos += count;
  }

  /** Consume sub-blocks without retaining their payloads. */
  skipSubBlocks(): void {
    for (;;) {
      const size = this.readByte();
      if (size === 0) {
        break;
      }
      this.skip(size);
    }
  }

  readSubBlocks(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (;;) {
      const size = this.readByte();
      if (size === 0) {
        break;
      }
      parts.push(this.readBytes(size));
    }
    return concatBytes(parts);
  }
}

function isGifHeader(bytes: Uint8Array): boolean {
  if (bytes.length < GIF_HEADER_LEN) {
    return false;
  }
  return (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

function isNetscapeId(id: Uint8Array): boolean {
  if (id.length < 11) {
    return false;
  }
  // NETSCAPE2.0 or ANIMEXTS1.0
  return (
    (id[0] === 0x4e &&
      id[1] === 0x45 &&
      id[2] === 0x54 &&
      id[3] === 0x53 &&
      id[4] === 0x43 &&
      id[5] === 0x41 &&
      id[6] === 0x50 &&
      id[7] === 0x45 &&
      id[8] === 0x32 &&
      id[9] === 0x2e &&
      id[10] === 0x30) ||
    (id[0] === 0x41 &&
      id[1] === 0x4e &&
      id[2] === 0x49 &&
      id[3] === 0x4d &&
      id[4] === 0x45 &&
      id[5] === 0x58 &&
      id[6] === 0x54 &&
      id[7] === 0x53 &&
      id[8] === 0x31 &&
      id[9] === 0x2e &&
      id[10] === 0x30)
  );
}

function deinterlace(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  let src = 0;
  for (let p = 0; p < passes.length; p++) {
    const pass = passes[p];
    if (pass === undefined) {
      continue;
    }
    for (let y = pass.start; y < height; y += pass.step) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const v = data[src];
        if (v === undefined) {
          throw gifError("unexpected end of image data");
        }
        out[row + x] = v;
        src += 1;
      }
    }
  }
  return out;
}

/** Disposal 2: browsers restore the frame rectangle to transparent, not the LSD background. */
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

function drawIndexed(
  canvas: Uint8Array,
  canvasW: number,
  indexed: Uint8Array,
  left: number,
  top: number,
  width: number,
  height: number,
  colorTable: Uint8Array,
  transparentIndex: number | undefined,
): void {
  for (let y = 0; y < height; y++) {
    const cy = top + y;
    for (let x = 0; x < width; x++) {
      const colorIndex = indexed[y * width + x];
      if (colorIndex === undefined) {
        throw gifError("unexpected end of image data");
      }
      if (transparentIndex !== undefined && colorIndex === transparentIndex) {
        continue;
      }
      const off = colorIndex * 3;
      const dst = (cy * canvasW + (left + x)) * 4;
      canvas[dst] = colorTable[off] ?? 0;
      canvas[dst + 1] = colorTable[off + 1] ?? 0;
      canvas[dst + 2] = colorTable[off + 2] ?? 0;
      canvas[dst + 3] = 255;
    }
  }
}

function checkImageRect(
  left: number,
  top: number,
  frameW: number,
  frameH: number,
  screenW: number,
  screenH: number,
): void {
  if (left + frameW > screenW || top + frameH > screenH) {
    throw gifError("image descriptor is outside the logical screen");
  }
}

function checkFrameBudget(
  width: number,
  height: number,
  frameCount: number,
  maxPixels: number,
): void {
  const perFrame = width * height;
  if (perFrame > 0 && frameCount > Math.floor(maxPixels / perFrame)) {
    throw gifError(
      `${frameCount} frames of ${width}x${height} exceed maxPixels (${frameCount * perFrame} > ${maxPixels}); raise maxPixels`,
    );
  }
}

/**
 * GIF87a / GIF89a decode: bytes in, composited RGBA frames out.
 *
 * Image descriptors that lie outside the logical screen throw (same rule as
 * `decodeApng`). `maxPixels` is a budget on **total** materialized pixels
 * (`logical-screen width × height × frame count`); the working canvas is
 * allocated only after the first image descriptor, so a header-only file does
 * not reserve a raster. Delays are milliseconds (centiseconds × 10; 0 stays 0).
 *
 * Disposal 3 restores the canvas saved before the frame was drawn. If nothing
 * was saved (first frame), the frame rectangle is cleared like disposal 2.
 */
export function decodeGif(bytes: Uint8Array, options?: DecodeLimits): GifDecodeResult {
  if (!isGifHeader(bytes)) {
    throw gifError("invalid header");
  }

  const maxPixels = options?.maxPixels ?? DEFAULT_MAX_PIXELS;
  const r = new ByteReader(bytes);
  r.readBytes(GIF_HEADER_LEN);

  const width = r.readUint16LE();
  const height = r.readUint16LE();
  checkDimensions("GIF", width, height, maxPixels);
  const packed = r.readByte();
  r.readByte();
  r.readByte();

  const hasGct = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 7);
  const gct = hasGct ? r.readBytes(gctSize * 3) : undefined;

  let loop: number | undefined;
  let delayCs = 0;
  let disposal = 0;
  let transparentIndex: number | undefined;

  let canvas: Uint8Array | undefined;
  const frames: PixelBuffer[] = [];
  const delays: number[] = [];
  let saved: Uint8Array | undefined;

  while (r.remaining > 0) {
    const sep = r.readByte();
    if (sep === 0x3b) {
      break;
    }
    if (sep === 0x00) {
      continue;
    }
    if (sep === 0x21) {
      const label = r.readByte();
      if (label === 0xf9) {
        const blockSize = r.readByte();
        if (blockSize < 4) {
          throw gifError("truncated graphic control extension");
        }
        const gcePacked = r.readByte();
        delayCs = r.readUint16LE();
        const trans = r.readByte();
        if (blockSize > 4) {
          r.skip(blockSize - 4);
        }
        r.skipSubBlocks();
        disposal = (gcePacked >> 2) & 7;
        if ((gcePacked & 1) !== 0) {
          transparentIndex = trans;
        } else {
          transparentIndex = undefined;
        }
      } else if (label === 0xff) {
        const idSize = r.readByte();
        const id = r.readBytes(idSize);
        if (isNetscapeId(id)) {
          const rest = r.readSubBlocks();
          if ((rest[0] ?? 0) === 1 && rest.length >= 3) {
            loop = (rest[1] ?? 0) | ((rest[2] ?? 0) << 8);
          }
        } else {
          r.skipSubBlocks();
        }
      } else {
        r.skipSubBlocks();
      }
      continue;
    }
    if (sep !== 0x2c) {
      throw gifError(`unexpected block 0x${sep.toString(16)}`);
    }

    const left = r.readUint16LE();
    const top = r.readUint16LE();
    const frameW = r.readUint16LE();
    const frameH = r.readUint16LE();
    checkDimensions("GIF", frameW, frameH, maxPixels);
    checkImageRect(left, top, frameW, frameH, width, height);

    const nextCount = frames.length + 1;
    checkFrameBudget(width, height, nextCount, maxPixels);

    const descPacked = r.readByte();
    const hasLct = (descPacked & 0x80) !== 0;
    const interlaced = (descPacked & 0x40) !== 0;
    const lctSize = 2 << (descPacked & 7);
    const lct = hasLct ? r.readBytes(lctSize * 3) : undefined;
    const colorTable = lct ?? gct;
    if (colorTable === undefined) {
      throw gifError("image has no color table");
    }

    const minCodeSize = r.readByte();
    const compressed = r.readSubBlocks();
    const needed = frameW * frameH;
    const raw = decodeLzw(minCodeSize, compressed, needed);
    if (raw.length < needed) {
      throw gifError("unexpected end of image data");
    }
    const indexed = interlaced ? deinterlace(raw, frameW, frameH) : raw;

    if (canvas === undefined) {
      canvas = new Uint8Array(width * height * 4);
    }

    if (disposal === 3) {
      saved = canvas.slice();
    }

    drawIndexed(canvas, width, indexed, left, top, frameW, frameH, colorTable, transparentIndex);
    frames.push({ width, height, data: canvas.slice() });
    delays.push(delayCs * 10);

    if (disposal === 2) {
      clearRect(canvas, width, height, left, top, frameW, frameH);
    } else if (disposal === 3) {
      if (saved !== undefined) {
        canvas.set(saved);
      } else {
        clearRect(canvas, width, height, left, top, frameW, frameH);
      }
    }

    delayCs = 0;
    disposal = 0;
    transparentIndex = undefined;
    saved = undefined;
  }

  if (frames.length === 0) {
    throw gifError("has no image data");
  }

  return { width, height, frames, delays, loop };
}
