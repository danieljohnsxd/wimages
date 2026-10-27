import { crc32 } from "./crc32.ts";
import { pngError, pngRangeError } from "./error.ts";

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function writeUint32BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

export function readUint32BE(data: Uint8Array, offset: number): number {
  const a = data[offset];
  const b = data[offset + 1];
  const c = data[offset + 2];
  const d = data[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw pngRangeError("unexpected end of data");
  }
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function readUint16BE(data: Uint8Array, offset: number): number {
  const a = data[offset];
  const b = data[offset + 1];
  if (a === undefined || b === undefined) {
    throw pngRangeError("unexpected end of data");
  }
  return (a << 8) | b;
}

export function writeUint16BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

export type PngChunk = {
  readonly type: string;
  readonly data: Uint8Array;
};

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if ((bytes[i] ?? 0) !== (PNG_SIGNATURE[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

function isAncillaryChunkType(firstByte: number): boolean {
  // PNG spec: bit 5 of the first type byte is the ancillary bit (lowercase).
  return (firstByte & 0x20) !== 0;
}

export function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  if (!hasPngSignature(bytes)) {
    throw pngError("invalid signature");
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw pngRangeError("truncated chunk");
    }
    const length = readUint32BE(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw pngRangeError("truncated chunk");
    }
    const t0 = bytes[typeStart];
    const t1 = bytes[typeStart + 1];
    const t2 = bytes[typeStart + 2];
    const t3 = bytes[typeStart + 3];
    if (t0 === undefined || t1 === undefined || t2 === undefined || t3 === undefined) {
      throw pngRangeError("truncated chunk");
    }
    const type = String.fromCharCode(t0, t1, t2, t3);
    const expectedCrc = readUint32BE(bytes, dataEnd);
    const actualCrc = crc32(bytes, typeStart, dataEnd);
    const crcOk = actualCrc === expectedCrc;
    if (!crcOk && !isAncillaryChunkType(t0)) {
      throw pngError(`bad CRC for ${type} chunk`);
    }
    // Bad CRC on ancillary (tEXt, tRNS, gAMA, …): skip, matching libpng/browsers.
    if (crcOk) {
      chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    }
    offset = dataEnd + 4;
    if (type === "IEND") {
      // Stop at IEND; ignore trailing garbage.
      return chunks;
    }
  }
  throw pngError("missing IEND");
}

/** Pack four ASCII chunk-type characters as a big-endian uint32. */
export function chunkType(a: string): number {
  if (a.length !== 4) {
    throw new TypeError("PNG: chunk type must be exactly 4 ASCII characters");
  }
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = a.charCodeAt(i);
    if (c > 127) {
      throw new TypeError("PNG: chunk type must be exactly 4 ASCII characters");
    }
    n = (n << 8) | c;
  }
  return n >>> 0;
}

export function createChunk(type: string, data: Uint8Array): Uint8Array {
  const typeCode = chunkType(type);
  const out = new Uint8Array(12 + data.length);
  writeUint32BE(out, 0, data.length);
  writeUint32BE(out, 4, typeCode);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  writeUint32BE(out, 8 + data.length, crc);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
