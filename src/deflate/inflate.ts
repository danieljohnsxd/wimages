import { canonicalCodes } from "./huffman.ts";
import { CL_ORDER, DIST_BASE, DIST_EXTRA, LEN_BASE, LEN_EXTRA } from "./tables.ts";

class BitReader {
  private readonly data: Uint8Array;
  private index = 0;
  private acc = 0;
  private bits = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Bytes consumed, not counting unused bits buffered by Huffman peeks. */
  get offset(): number {
    return this.index - (this.bits >> 3);
  }

  /** Pull real input bytes until `need` bits are buffered, or the input ends. */
  private pull(need: number): void {
    while (this.bits < need && this.index < this.data.length) {
      const b = this.data[this.index] ?? 0;
      this.index += 1;
      this.acc |= b << this.bits;
      this.bits += 8;
    }
  }

  private hasBits(n: number): boolean {
    if (this.bits >= n) {
      return true;
    }
    const need = n - this.bits;
    return this.data.length - this.index >= (need + 7) >> 3;
  }

  /**
   * Next `n` bits, padding with zeros past the end of input so a short final
   * Huffman symbol can be looked up in a table wider than the remaining bits.
   */
  peek(n: number): number {
    if (n === 0) {
      return 0;
    }
    this.pull(n);
    return this.acc & ((1 << n) - 1);
  }

  /** Consume `n` real bits. Throws if the stream does not contain them. */
  read(n: number): number {
    if (n === 0) {
      return 0;
    }
    if (!this.hasBits(n)) {
      throw new Error("truncated deflate stream");
    }
    this.pull(n);
    const v = this.acc & ((1 << n) - 1);
    this.acc >>>= n;
    this.bits -= n;
    return v;
  }

  alignToByte(): void {
    this.index = this.offset;
    this.acc = 0;
    this.bits = 0;
  }

  readBytes(n: number): Uint8Array {
    this.alignToByte();
    const end = this.index + n;
    if (end > this.data.length) {
      throw new Error("truncated deflate stream");
    }
    const out = this.data.subarray(this.index, end);
    this.index = end;
    return out;
  }
}

type HuffDec = {
  readonly max: number;
  readonly symbols: Int16Array;
  readonly lengths: Uint8Array;
};

function makeDecoder(codeLengths: Uint8Array): HuffDec {
  const codes = canonicalCodes(codeLengths);
  let max = 0;
  for (let i = 0; i < codeLengths.length; i++) {
    const len = codeLengths[i] ?? 0;
    if (len > max) {
      max = len;
    }
  }
  if (max === 0) {
    throw new Error("empty Huffman table");
  }
  const size = 1 << max;
  const symbols = new Int16Array(size).fill(-1);
  const lengths = new Uint8Array(size);
  for (let sym = 0; sym < codeLengths.length; sym++) {
    const len = codeLengths[sym] ?? 0;
    if (len === 0) {
      continue;
    }
    const code = codes[sym] ?? 0;
    const step = 1 << len;
    for (let i = code; i < size; i += step) {
      symbols[i] = sym;
      lengths[i] = len;
    }
  }
  return { max, symbols, lengths };
}

function decodeSymbol(r: BitReader, dec: HuffDec): number {
  const peek = r.peek(dec.max);
  const len = dec.lengths[peek] ?? 0;
  const sym = dec.symbols[peek] ?? -1;
  if (len === 0 || sym < 0) {
    throw new Error("invalid Huffman code");
  }
  r.read(len);
  return sym;
}

function fixedLitDecoder(): HuffDec {
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
  return makeDecoder(lengths);
}

function fixedDistDecoder(): HuffDec {
  return makeDecoder(new Uint8Array(32).fill(5));
}

const FIXED_LIT = fixedLitDecoder();
const FIXED_DIST = fixedDistDecoder();

function readCodeLengths(r: BitReader, cl: HuffDec, count: number): Uint8Array {
  const lengths = new Uint8Array(count);
  let i = 0;
  let prev = 0;
  while (i < count) {
    const sym = decodeSymbol(r, cl);
    if (sym < 16) {
      lengths[i] = sym;
      prev = sym;
      i += 1;
      continue;
    }
    let repeat = 0;
    let value = 0;
    if (sym === 16) {
      if (i === 0) {
        throw new Error("deflate: repeat with no previous length");
      }
      repeat = 3 + r.read(2);
      value = prev;
    } else if (sym === 17) {
      repeat = 3 + r.read(3);
      value = 0;
    } else if (sym === 18) {
      repeat = 11 + r.read(7);
      value = 0;
    } else {
      throw new Error("deflate: invalid code-length symbol");
    }
    if (i + repeat > count) {
      throw new Error("deflate: code-length run overflows");
    }
    for (let n = 0; n < repeat; n++) {
      lengths[i] = value;
      i += 1;
    }
    if (sym === 16) {
      prev = value;
    }
  }
  return lengths;
}

function readDynamic(r: BitReader): { readonly lit: HuffDec; readonly dist: HuffDec } {
  const hlit = r.read(5) + 257;
  const hdist = r.read(5) + 1;
  const hclen = r.read(4) + 4;
  const clLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) {
    const sym = CL_ORDER[i] ?? 0;
    clLengths[sym] = r.read(3);
  }
  const cl = makeDecoder(clLengths);
  const all = readCodeLengths(r, cl, hlit + hdist);
  return {
    lit: makeDecoder(all.subarray(0, hlit)),
    dist: makeDecoder(all.subarray(hlit)),
  };
}

class Output {
  private buf: Uint8Array;
  private len = 0;
  private readonly max: number | undefined;

  constructor(hint: number, maxOutput?: number) {
    if (maxOutput !== undefined && (!Number.isFinite(maxOutput) || maxOutput < 0)) {
      throw new RangeError("deflate: maxOutput must be a non-negative number");
    }
    this.max = maxOutput;
    let cap = hint > 0 ? hint : 1024;
    if (this.max !== undefined) {
      cap = Math.min(cap, this.max);
    }
    this.buf = new Uint8Array(cap);
  }

  get length(): number {
    return this.len;
  }

  push(b: number): void {
    this.ensure(1);
    this.buf[this.len] = b;
    this.len += 1;
  }

  append(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  copy(distance: number, length: number): void {
    if (distance < 1 || distance > this.len) {
      throw new Error("deflate: invalid match distance");
    }
    this.ensure(length);
    let from = this.len - distance;
    for (let i = 0; i < length; i++) {
      this.buf[this.len] = this.buf[from] ?? 0;
      this.len += 1;
      from += 1;
    }
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (this.max !== undefined && need > this.max) {
      throw new Error(`deflate: output exceeds maxOutput (${need} > ${this.max})`);
    }
    if (need <= this.buf.length) {
      return;
    }
    let cap = this.buf.length === 0 ? 1 : this.buf.length;
    while (cap < need) {
      cap *= 2;
    }
    if (this.max !== undefined && cap > this.max) {
      cap = this.max;
    }
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

function inflateBlock(r: BitReader, out: Output, lit: HuffDec, dist: HuffDec): void {
  for (;;) {
    const sym = decodeSymbol(r, lit);
    if (sym < 256) {
      out.push(sym);
      continue;
    }
    if (sym === 256) {
      return;
    }
    const li = sym - 257;
    const base = LEN_BASE[li];
    const extraBits = LEN_EXTRA[li];
    if (base === undefined || extraBits === undefined) {
      throw new Error("deflate: invalid length symbol");
    }
    const length = base + r.read(extraBits);
    const ds = decodeSymbol(r, dist);
    const dbase = DIST_BASE[ds];
    const dextra = DIST_EXTRA[ds];
    if (dbase === undefined || dextra === undefined) {
      throw new Error("deflate: invalid distance symbol");
    }
    const distance = dbase + r.read(dextra);
    out.copy(distance, length);
  }
}

export type InflateResult = {
  readonly output: Uint8Array;
  readonly consumed: number;
};

/** Raw RFC 1951 inflate (no zlib wrapper). `maxOutput` caps decompressed size. */
export function inflateRaw(data: Uint8Array, expectedSize = 0, maxOutput?: number): InflateResult {
  const r = new BitReader(data);
  const out = new Output(expectedSize, maxOutput);
  for (;;) {
    const last = r.read(1) === 1;
    const type = r.read(2);
    if (type === 0) {
      const bytes = r.readBytes(4);
      const len = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
      const nlen = (bytes[2] ?? 0) | ((bytes[3] ?? 0) << 8);
      if ((len ^ 0xffff) !== nlen) {
        throw new Error("deflate: bad stored-block length");
      }
      out.append(r.readBytes(len));
    } else if (type === 1) {
      inflateBlock(r, out, FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      const tables = readDynamic(r);
      inflateBlock(r, out, tables.lit, tables.dist);
    } else {
      throw new Error("deflate: reserved block type");
    }
    if (last) {
      break;
    }
  }
  return { output: out.finish(), consumed: r.offset };
}
