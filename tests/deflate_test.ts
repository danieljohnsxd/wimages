import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync, inflateSync } from "node:zlib";
import { test } from "node:test";
import { deflateRaw } from "../src/deflate/deflate.ts";
import { codeLengthsFromFreq } from "../src/deflate/huffman.ts";
import { inflateRaw } from "../src/deflate/inflate.ts";
import { zlibDeflate, zlibInflate } from "../src/deflate/zlib.ts";
import { encodePng, createPixelBuffer, decodePng } from "../dist/index.js";
import { parsePngChunks } from "./png_decode_helper.ts";

function idatZlib(png: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of parsePngChunks(png)) {
    if (chunk.type === "IDAT") {
      parts.push(chunk.data);
    }
  }
  let n = 0;
  for (const p of parts) {
    n += p.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("IDAT is a zlib stream node can inflate (empty-ish 1x1)", () => {
  const png = encodePng(createPixelBuffer(1, 1), { colorType: "rgba", effort: "fast" });
  const raw = inflateSync(idatZlib(png));
  assert.equal(raw.length, 1 + 4);
  assert.equal(raw[0], 1); // "fast" always uses the sub filter
});

test("deflateRaw stored blocks (level 0) inflate", () => {
  const data = new Uint8Array(8 * 4 * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 17) & 0xff;
  }
  const compressed = deflateRaw(data, 0);
  const { output, consumed } = inflateRaw(compressed);
  assert.equal(consumed, compressed.length);
  assert.deepEqual(output, data);
  assert.deepEqual(new Uint8Array(inflateRawSync(compressed)), data);
});

test("repetitive scanlines compress and inflate at effort strong", () => {
  const img = createPixelBuffer(64, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      img.data[i] = 40;
      img.data[i + 1] = 80;
      img.data[i + 2] = 120;
      img.data[i + 3] = 255;
    }
  }
  const png = encodePng(img, { effort: "strong", colorType: "rgba" });
  const raw = inflateSync(idatZlib(png));
  assert.ok(raw.length > 0);
  assert.ok(idatZlib(png).length < raw.length);
});

const TEXT = "The quick brown fox jumps over the lazy dog. 0123456789\n";

function mixedBytes(incompressible: number): Uint8Array {
  const compressible = 32 * 1024;
  const out = new Uint8Array(compressible + incompressible + compressible);
  for (let i = 0; i < compressible; i++) {
    out[i] = TEXT.charCodeAt(i % TEXT.length);
    out[compressible + incompressible + i] = TEXT.charCodeAt(i % TEXT.length);
  }
  let seed = 0x9e3779b9;
  for (let i = 0; i < incompressible; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out[compressible + i] = seed >>> 24;
  }
  return out;
}

for (const incompressible of [8 * 1024, 32 * 1024, 64 * 1024]) {
  test(`deflateRaw/inflateRaw [32KB text][${incompressible / 1024}KB random][32KB text]`, () => {
    const data = mixedBytes(incompressible);
    const compressed = deflateRaw(data, 6);
    const { output, consumed } = inflateRaw(compressed);
    assert.equal(consumed, compressed.length);
    assert.deepEqual(output, data);
    assert.deepEqual(new Uint8Array(inflateRawSync(compressed)), data);
  });
}

class TestBits {
  private buf = new Uint8Array(64);
  private byteLen = 0;
  private acc = 0;
  private bits = 0;

  write(value: number, n: number): void {
    this.acc |= (value & ((1 << n) - 1)) << this.bits;
    this.bits += n;
    while (this.bits >= 8) {
      this.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }

  writeBytes(bytes: Uint8Array): void {
    this.align();
    const need = this.byteLen + bytes.length;
    if (need > this.buf.length) {
      const next = new Uint8Array(need * 2);
      next.set(this.buf.subarray(0, this.byteLen));
      this.buf = next;
    }
    this.buf.set(bytes, this.byteLen);
    this.byteLen += bytes.length;
  }

  writeUint16LE(value: number): void {
    this.align();
    this.push(value & 0xff);
    this.push((value >>> 8) & 0xff);
  }

  finish(): Uint8Array {
    this.align();
    return this.buf.subarray(0, this.byteLen);
  }

  private align(): void {
    if (this.bits > 0) {
      this.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
  }

  private push(b: number): void {
    if (this.byteLen >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.byteLen] = b;
    this.byteLen += 1;
  }
}

function reverseBits(code: number, len: number): number {
  let rev = 0;
  let c = code;
  for (let i = 0; i < len; i++) {
    rev = (rev << 1) | (c & 1);
    c >>>= 1;
  }
  return rev;
}

function writeFixedLiteral(w: TestBits, sym: number): void {
  let len = 0;
  let rfc = 0;
  if (sym <= 143) {
    len = 8;
    rfc = 0x30 + sym;
  } else if (sym <= 255) {
    len = 9;
    rfc = 0x190 + (sym - 144);
  } else if (sym <= 279) {
    len = 7;
    rfc = sym - 256;
  } else {
    len = 8;
    rfc = 0xc0 + (sym - 280);
  }
  w.write(reverseBits(rfc, len), len);
}

function writeStored(w: TestBits, payload: Uint8Array, final: boolean): void {
  w.write(final ? 1 : 0, 1);
  w.write(0, 2);
  w.writeUint16LE(payload.length);
  w.writeUint16LE(~payload.length & 0xffff);
  w.writeBytes(payload);
}

function adler32(data: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + (data[i] ?? 0)) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] ?? 0;
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function be32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function zlibWrap(deflate: Uint8Array, inflated: Uint8Array): Uint8Array {
  const sum = adler32(inflated);
  const out = new Uint8Array(2 + deflate.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(deflate, 2);
  const t = 2 + deflate.length;
  out[t] = (sum >>> 24) & 0xff;
  out[t + 1] = (sum >>> 16) & 0xff;
  out[t + 2] = (sum >>> 8) & 0xff;
  out[t + 3] = sum & 0xff;
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ]);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length));
  out.set(crcInput, 4);
  out.set(be32(crc32(crcInput)), 8 + data.length);
  return out;
}

function grayPng(width: number, height: number, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width));
  ihdr.set(be32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  let n = 0;
  for (const p of parts) {
    n += p.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

test("fixed-Huffman block then stored then final stored inflates to exact bytes", () => {
  const w = new TestBits();
  w.write(0, 1);
  w.write(1, 2);
  writeFixedLiteral(w, 0);
  writeFixedLiteral(w, 10);
  writeFixedLiteral(w, 256);
  writeStored(w, new Uint8Array([20, 30]), false);
  writeStored(w, new Uint8Array([40]), true);
  const deflate = w.finish();
  const inflated = new Uint8Array([0, 10, 20, 30, 40]);
  assert.deepEqual(new Uint8Array(inflateRawSync(deflate)), inflated);
  const { output, consumed } = inflateRaw(deflate);
  assert.deepEqual(output, inflated);
  assert.equal(consumed, deflate.length);

  const png = grayPng(4, 1, zlibWrap(deflate, inflated));
  const decoded = decodePng(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 1);
  assert.deepEqual(
    decoded.data,
    new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255]),
  );
});

test("15-bit dynamic Huffman then stored then final stored inflates to exact bytes", () => {
  // Lit lengths 2..15 plus 1-bit EOB so decodeSymbol peeks 15 bits into LEN/NLEN.
  const deflate = bytesFromHex(
    "04e00182244992244922b1a87964f5ecddff9f0bd0bfff3f000500faff0908070605010100feff04",
  );
  const inflated = new Uint8Array([0, 7, 14, 9, 8, 7, 6, 5, 4]);
  assert.deepEqual(new Uint8Array(inflateRawSync(deflate)), inflated);
  const { output, consumed } = inflateRaw(deflate);
  assert.deepEqual(output, inflated);
  assert.equal(consumed, deflate.length);
});

test("zlib Adler-32 is located when the deflate stream ends mid-byte", () => {
  const w = new TestBits();
  w.write(1, 1);
  w.write(1, 2);
  writeFixedLiteral(w, 0);
  writeFixedLiteral(w, 99);
  writeFixedLiteral(w, 256);
  const deflate = w.finish();
  const inflated = new Uint8Array([0, 99]);
  assert.deepEqual(new Uint8Array(inflateRawSync(deflate)), inflated);
  const { consumed } = inflateRaw(deflate);
  assert.equal(consumed, deflate.length);

  const zlib = zlibWrap(deflate, inflated);
  assert.deepEqual(zlibInflate(zlib), inflated);

  const padded = new Uint8Array(zlib.length + 3);
  padded.set(zlib);
  padded[zlib.length] = 0xaa;
  padded[zlib.length + 1] = 0xbb;
  padded[zlib.length + 2] = 0xcc;
  assert.deepEqual(zlibInflate(padded), inflated);

  const png = grayPng(1, 1, zlib);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.deepEqual(decoded.data, new Uint8Array([99, 99, 99, 255]));
});

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function genBytes(n: number, mode: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  const next = lcg(seed);
  if (mode === 0) {
    return out;
  }
  if (mode === 1) {
    for (let i = 0; i < n; i++) {
      out[i] = next() >>> 24;
    }
    return out;
  }
  if (mode === 2) {
    for (let i = 0; i < n; i++) {
      out[i] = TEXT.charCodeAt(i % TEXT.length);
    }
    return out;
  }
  if (mode === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = (i & 1) === 0 ? 0 : next() >>> 24;
    }
    return out;
  }
  const mid = n >> 1;
  for (let i = 0; i < mid; i++) {
    out[i] = TEXT.charCodeAt(i % TEXT.length);
  }
  for (let i = mid; i < n; i++) {
    out[i] = next() >>> 24;
  }
  return out;
}

type CorpusItem = { readonly name: string; readonly data: Uint8Array };

function deflateCorpus(): CorpusItem[] {
  const items: CorpusItem[] = [
    { name: "empty", data: new Uint8Array(0) },
    { name: "zeros-16", data: new Uint8Array(16) },
    { name: "one-byte", data: new Uint8Array([42]) },
    { name: "mixed-70000", data: genBytes(70000, 4, 0x9e3779b9) },
    { name: "gen-143-n2907-m3", data: genBytes(2907, 3, 143) },
  ];
  const sizes = [1, 2, 3, 7, 8, 15, 16, 17, 31, 32, 64, 127, 128, 255, 256, 1024, 2048, 4096];
  let id = 0;
  for (const n of sizes) {
    for (const mode of [0, 1, 2, 3, 4]) {
      for (const seed of [1, 143]) {
        items.push({ name: `gen-${id}-n${n}-m${mode}`, data: genBytes(n, mode, seed) });
        id += 1;
      }
    }
  }
  return items;
}

test("deflateRaw and zlibDeflate round-trip through node:zlib at every level", () => {
  const corpus = deflateCorpus();
  assert.ok(corpus.length > 180);
  for (const { name, data } of corpus) {
    for (let level = 0; level <= 9; level++) {
      const raw = deflateRaw(data, level);
      let inflated: Uint8Array;
      try {
        inflated = new Uint8Array(inflateRawSync(raw));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${name} level=${level} deflateRaw: ${msg}`, { cause: err });
      }
      assert.deepEqual(inflated, data, `${name} level=${level} deflateRaw`);

      const wrapped = zlibDeflate(data, level);
      let zInflated: Uint8Array;
      try {
        zInflated = new Uint8Array(inflateSync(wrapped));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${name} level=${level} zlibDeflate: ${msg}`, { cause: err });
      }
      assert.deepEqual(zInflated, data, `${name} level=${level} zlibDeflate`);
    }
  }
});

test("inflateRaw reads node:zlib deflateRawSync including 16 zeros", () => {
  const zeros16 = new Uint8Array(16);
  const z16 = new Uint8Array(deflateRawSync(zeros16, { level: 1 }));
  assert.equal(z16.length, 5);
  const got = inflateRaw(z16);
  assert.deepEqual(got.output, zeros16);
  assert.equal(got.consumed, 5);

  const padded = new Uint8Array(z16.length + 8);
  padded.set(z16);
  const gotPadded = inflateRaw(padded);
  assert.deepEqual(gotPadded.output, zeros16);
  assert.equal(gotPadded.consumed, 5);

  for (const { name, data } of deflateCorpus()) {
    for (let level = 0; level <= 9; level++) {
      const raw = new Uint8Array(deflateRawSync(data, { level }));
      const extra = new Uint8Array(raw.length + 4);
      extra.set(raw);
      extra[raw.length] = 0xaa;
      extra[raw.length + 1] = 0xbb;
      extra[raw.length + 2] = 0xcc;
      extra[raw.length + 3] = 0xdd;
      let result: { output: Uint8Array; consumed: number };
      try {
        result = inflateRaw(extra);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${name} level=${level} inflateRaw: ${msg}`, { cause: err });
      }
      assert.deepEqual(result.output, data, `${name} level=${level}`);
      assert.equal(result.consumed, raw.length, `${name} level=${level} consumed`);
    }
  }
});

test("truncated extra-bits and stored payloads still throw", () => {
  assert.throws(() => inflateRaw(new Uint8Array([0x03])), /truncated deflate stream/);
  const stored = deflateRaw(new Uint8Array([1, 2, 3, 4]), 0);
  assert.throws(() => inflateRaw(stored.subarray(0, 2)), /truncated deflate stream/);
});

function kraftUnits(
  lengths: Uint8Array,
  maxBits: number,
): { readonly units: number; readonly goal: number; readonly used: number } {
  let units = 0;
  let used = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] ?? 0;
    if (len === 0) {
      continue;
    }
    assert.ok(len >= 1 && len <= maxBits, `length ${len} outside 1..${maxBits}`);
    units += 1 << (maxBits - len);
    used += 1;
  }
  return { units, goal: 1 << maxBits, used };
}

function fibFreq(n: number): Uint32Array {
  const freq = new Uint32Array(n);
  if (n > 0) {
    freq[0] = 1;
  }
  if (n > 1) {
    freq[1] = 1;
  }
  for (let i = 2; i < n; i++) {
    const a = freq[i - 1] ?? 1;
    const b = freq[i - 2] ?? 1;
    const sum = a + b;
    freq[i] = sum > 0xffffffff ? 0xffffffff : sum;
  }
  return freq;
}

function assertComplete(lengths: Uint8Array, maxBits: number, label: string): void {
  const k = kraftUnits(lengths, maxBits);
  assert.equal(k.units, k.goal, `${label}: Kraft ${k.units}/${k.goal} used=${k.used}`);
}

function assertSingleLength1(lengths: Uint8Array, maxBits: number, label: string): void {
  const k = kraftUnits(lengths, maxBits);
  assert.equal(k.used, 1, `${label}: expected one used symbol`);
  assert.equal(k.units, k.goal >> 1, `${label}: expected one length-1 code`);
}

test("length limiter Kraft sum is 1 except the single-symbol lit/dist case", () => {
  const empty = codeLengthsFromFreq(new Uint32Array(30), 15);
  assert.equal(kraftUnits(empty, 15).used, 0);

  const one = new Uint32Array(286);
  one[17] = 9;
  assertSingleLength1(codeLengthsFromFreq(one, 15), 15, "one lit");

  const two = new Uint32Array(286);
  two[0] = 5;
  two[1] = 7;
  assertComplete(codeLengthsFromFreq(two, 15), 15, "two symbols");

  const eq = new Uint32Array(286).fill(1);
  assertComplete(codeLengthsFromFreq(eq, 15), 15, "286 equal");

  const skew = new Uint32Array(286);
  skew[0] = 1_000_000_000;
  for (let i = 1; i < 286; i++) {
    skew[i] = 1;
  }
  assertComplete(codeLengthsFromFreq(skew, 15), 15, "extreme skew");

  const revSkew = new Uint32Array(286);
  revSkew[285] = 1_000_000_000;
  for (let i = 0; i < 285; i++) {
    revSkew[i] = 1;
  }
  assertComplete(codeLengthsFromFreq(revSkew, 15), 15, "high-index skew");

  assertComplete(codeLengthsFromFreq(fibFreq(286), 15), 15, "fib 286 / 15");
  assertComplete(codeLengthsFromFreq(fibFreq(19), 7, 2), 7, "fib 19 CL / 7");
  assertComplete(codeLengthsFromFreq(fibFreq(32), 15), 15, "fib 32 / 15");

  const oneCl = new Uint32Array(19);
  oneCl[18] = 3;
  const cl = codeLengthsFromFreq(oneCl, 7, 2);
  assertComplete(cl, 7, "single CL symbol padded to complete");
  assert.equal(kraftUnits(cl, 7).used, 2);
});
