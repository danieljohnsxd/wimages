import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeLzw, encodeLzw } from "../src/gif/lzw.ts";

const MAX_CODE = 4096;

function hitsEoiWidthBump(minCodeSize: number, indexes: Uint8Array): boolean {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const dict = new Map<number, number>();
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  if (indexes.length === 0) {
    return false;
  }
  let prefix = indexes[0] ?? 0;
  for (let i = 1; i < indexes.length; i++) {
    const k = indexes[i] ?? 0;
    const key = (prefix << 8) | k;
    const existing = dict.get(key);
    if (existing !== undefined) {
      prefix = existing;
      continue;
    }
    if (nextCode < MAX_CODE) {
      dict.set(key, nextCode);
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
      nextCode += 1;
      if (nextCode >= MAX_CODE) {
        dict.clear();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
    } else {
      dict.clear();
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  return nextCode === 1 << codeSize && codeSize < 12;
}

function altIndexes(length: number, modulo: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = i % modulo;
  }
  return out;
}

/**
 * Index streams that land the last dictionary add on 2^n, so the decoder
 * widens before reading EOI. Lengths from an encoder-state search.
 */
function eoiBumpIndexes(minCodeSize: number): Uint8Array {
  switch (minCodeSize) {
    case 2:
      return altIndexes(3, 2);
    case 3:
      return altIndexes(13, 2);
    case 4:
      return altIndexes(57, 2);
    case 5:
      return altIndexes(241, 2);
    case 6:
      return altIndexes(993, 2);
    case 7:
      return altIndexes(127, 1 << 7);
    case 8:
      return altIndexes(255, 1 << 8);
    default:
      throw new Error(`unsupported min code size ${minCodeSize}`);
  }
}

test("LZW round-trips every min code size 2–8 on an EOI width-increase stream", () => {
  for (let minCodeSize = 2; minCodeSize <= 8; minCodeSize++) {
    const indexes = eoiBumpIndexes(minCodeSize);
    assert.equal(
      hitsEoiWidthBump(minCodeSize, indexes),
      true,
      `minCodeSize ${minCodeSize} must hit the EOI width bump`,
    );
    const encoded = encodeLzw(minCodeSize, indexes);
    const decoded = decodeLzw(minCodeSize, encoded, indexes.length);
    assert.deepEqual(decoded, indexes, `minCodeSize ${minCodeSize} pixels`);
    assert.ok(encoded.length > 0);
  }
});

test("LZW decode throws when output exceeds maxOutput", () => {
  const indexes = new Uint8Array(32);
  const encoded = encodeLzw(2, indexes);
  assert.throws(() => decodeLzw(2, encoded, 1), /GIF: LZW data exceeds frame size/);
  assert.throws(() => decodeLzw(2, encoded, 8), /GIF: LZW data exceeds frame size/);
  const exact = decodeLzw(2, encoded, 32);
  assert.deepEqual(exact, indexes);
});

test("LZW decode rejects a code past the next available slot", () => {
  // minCodeSize 2: CLEAR=4 then code 7 (next available is 6) packed 3-bit LSB.
  const bytes = Uint8Array.of(0x3c);
  assert.throws(() => decodeLzw(2, bytes, 16), /GIF: invalid LZW code/);
});

test("LZW KwKwK (code === next) is accepted", () => {
  const indexes = Uint8Array.of(0, 0, 0, 0);
  const encoded = encodeLzw(2, indexes);
  const decoded = decodeLzw(2, encoded, indexes.length);
  assert.deepEqual(decoded, indexes);
});

test("LZW min code size is validated", () => {
  assert.throws(() => encodeLzw(1, new Uint8Array([0])), /GIF: LZW min code size/);
  assert.throws(() => decodeLzw(9, new Uint8Array([0]), 1), /GIF: LZW min code size/);
});
