/** Base match lengths for codes 257–285. */
export const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];

export const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

export const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];

export const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** RFC 1951 code-length code order. */
export const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export function lengthSymbol(length: number): {
  readonly sym: number;
  readonly extra: number;
  readonly extraBits: number;
} {
  if (length < 3 || length > 258) {
    throw new RangeError("deflate match length must be 3–258");
  }
  if (length === 258) {
    return { sym: 285, extra: 0, extraBits: 0 };
  }
  for (let i = LEN_BASE.length - 1; i >= 0; i--) {
    const base = LEN_BASE[i] ?? 0;
    if (length >= base) {
      const extraBits = LEN_EXTRA[i] ?? 0;
      return { sym: 257 + i, extra: length - base, extraBits };
    }
  }
  throw new RangeError("deflate match length must be 3–258");
}

export function distanceSymbol(distance: number): {
  readonly sym: number;
  readonly extra: number;
  readonly extraBits: number;
} {
  if (distance < 1 || distance > 32768) {
    throw new RangeError("deflate match distance must be 1–32768");
  }
  for (let i = DIST_BASE.length - 1; i >= 0; i--) {
    const base = DIST_BASE[i] ?? 0;
    if (distance >= base) {
      const extraBits = DIST_EXTRA[i] ?? 0;
      return { sym: i, extra: distance - base, extraBits };
    }
  }
  throw new RangeError("deflate match distance must be 1–32768");
}

/** Fixed Huffman bit lengths: 288 lit/len, 32 dist (last two lit unused). */
export function fixedLitLenLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) {
    lengths[i] = 8;
  }
  for (let i = 144; i < 256; i++) {
    lengths[i] = 9;
  }
  for (let i = 256; i < 280; i++) {
    lengths[i] = 7;
  }
  for (let i = 280; i < 288; i++) {
    lengths[i] = 8;
  }
  return lengths;
}

export function fixedDistLengths(): Uint8Array {
  return new Uint8Array(32).fill(5);
}
