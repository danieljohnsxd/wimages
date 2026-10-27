import { adler32 } from "./adler32.ts";
import { deflateRaw } from "./deflate.ts";
import { inflateRaw } from "./inflate.ts";

function zlibHeader(level: number): Uint8Array {
  const cmf = 0x78;
  let flevel = 2;
  if (level <= 1) {
    flevel = 0;
  } else if (level <= 5) {
    flevel = 1;
  } else if (level >= 9) {
    flevel = 3;
  }
  let flg = flevel << 6;
  const check = (cmf * 256 + flg) % 31;
  flg += (31 - check) % 31;
  return new Uint8Array([cmf, flg]);
}

/** zlib-wrapped deflate (CMF/FLG + deflate + Adler-32), as required by PNG IDAT. */
export function zlibDeflate(data: Uint8Array, level = 6): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new RangeError("level must be an integer from 0 to 9");
  }
  const header = zlibHeader(level);
  const body = deflateRaw(data, level);
  const sum = adler32(data);
  const out = new Uint8Array(header.length + body.length + 4);
  out.set(header, 0);
  out.set(body, header.length);
  const t = header.length + body.length;
  out[t] = (sum >>> 24) & 0xff;
  out[t + 1] = (sum >>> 16) & 0xff;
  out[t + 2] = (sum >>> 8) & 0xff;
  out[t + 3] = sum & 0xff;
  return out;
}

/** Inflate a zlib stream (PNG IDAT). `maxOutput` caps decompressed size. */
export function zlibInflate(data: Uint8Array, expectedSize = 0, maxOutput?: number): Uint8Array {
  if (data.length < 6) {
    throw new Error("truncated zlib stream");
  }
  const cmf = data[0] ?? 0;
  const flg = data[1] ?? 0;
  if ((cmf & 0x0f) !== 8) {
    throw new Error("zlib compression method must be deflate");
  }
  if (((cmf << 8) | flg) % 31 !== 0) {
    throw new Error("zlib header checksum failed");
  }
  if ((flg & 0x20) !== 0) {
    throw new Error("zlib preset dictionary is not supported");
  }
  const body = data.subarray(2);
  const inflated = inflateRaw(body, expectedSize, maxOutput);
  const adlerAt = 2 + inflated.consumed;
  if (adlerAt + 4 > data.length) {
    throw new Error("truncated zlib checksum");
  }
  const a0 = data[adlerAt] ?? 0;
  const a1 = data[adlerAt + 1] ?? 0;
  const a2 = data[adlerAt + 2] ?? 0;
  const a3 = data[adlerAt + 3] ?? 0;
  const stored = ((a0 << 24) | (a1 << 16) | (a2 << 8) | a3) >>> 0;
  const actual = adler32(inflated.output);
  if (stored !== actual) {
    throw new Error("zlib Adler-32 mismatch");
  }
  return inflated.output;
}
