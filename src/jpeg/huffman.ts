import type { BitReader, BitWriter } from "./bits.ts";
import { jpegError } from "./error.ts";
import {
  AC_CHR_BITS,
  AC_CHR_VALS,
  AC_LUM_BITS,
  AC_LUM_VALS,
  DC_CHR_BITS,
  DC_CHR_VALS,
  DC_LUM_BITS,
  DC_LUM_VALS,
} from "./tables.ts";

export type HuffmanEncode = {
  readonly codes: Uint16Array;
  readonly sizes: Uint8Array;
};

export type HuffmanDecode = {
  readonly minCode: Int32Array;
  readonly maxCode: Int32Array;
  readonly valPtr: Int32Array;
  readonly huffVal: Uint8Array;
};

export function buildEncodeTable(bits: Uint8Array, vals: Uint8Array): HuffmanEncode {
  const codes = new Uint16Array(256);
  const sizes = new Uint8Array(256);
  let code = 0;
  let vi = 0;
  for (let len = 1; len <= 16; len++) {
    const n = bits[len - 1] ?? 0;
    for (let i = 0; i < n; i++) {
      const sym = vals[vi];
      if (sym === undefined) {
        throw jpegError("Huffman table value overrun");
      }
      codes[sym] = code;
      sizes[sym] = len;
      code += 1;
      vi += 1;
    }
    code <<= 1;
  }
  return { codes, sizes };
}

export function buildDecodeTable(bits: Uint8Array, vals: Uint8Array): HuffmanDecode {
  const minCode = new Int32Array(16);
  const maxCode = new Int32Array(16);
  const valPtr = new Int32Array(16);
  minCode.fill(-1);
  maxCode.fill(-1);
  valPtr.fill(-1);
  let code = 0;
  let vi = 0;
  for (let i = 0; i < 16; i++) {
    const n = bits[i] ?? 0;
    if (n > 0) {
      minCode[i] = code;
      valPtr[i] = vi;
      for (let j = 0; j < n; j++) {
        code += 1;
        vi += 1;
      }
      maxCode[i] = code - 1;
    }
    code <<= 1;
  }
  return { minCode, maxCode, valPtr, huffVal: vals };
}

export const DC_LUM_ENCODE = buildEncodeTable(DC_LUM_BITS, DC_LUM_VALS);
export const AC_LUM_ENCODE = buildEncodeTable(AC_LUM_BITS, AC_LUM_VALS);
export const DC_CHR_ENCODE = buildEncodeTable(DC_CHR_BITS, DC_CHR_VALS);
export const AC_CHR_ENCODE = buildEncodeTable(AC_CHR_BITS, AC_CHR_VALS);

function bitSize(abs: number): number {
  if (abs === 0) {
    return 0;
  }
  return 32 - Math.clz32(abs);
}

function additionalBits(value: number, size: number): number {
  if (size === 0) {
    return 0;
  }
  return value < 0 ? value + (1 << size) - 1 : value;
}

function extendBits(bits: number, size: number): number {
  if (size === 0) {
    return 0;
  }
  const vt = 1 << (size - 1);
  if (bits < vt) {
    return bits - (1 << size) + 1;
  }
  return bits;
}

function writeSymbol(w: BitWriter, table: HuffmanEncode, symbol: number): void {
  const size = table.sizes[symbol] ?? 0;
  const code = table.codes[symbol] ?? 0;
  if (size === 0) {
    throw jpegError(`Huffman symbol 0x${symbol.toString(16)} is not in the table`);
  }
  w.writeBits(code, size);
}

export function encodeDc(w: BitWriter, table: HuffmanEncode, diff: number): void {
  let v = diff;
  if (v > 2047) {
    v = 2047;
  } else if (v < -2047) {
    v = -2047;
  }
  const size = bitSize(v < 0 ? -v : v);
  const huffSize = table.sizes[size] ?? 0;
  const huffCode = table.codes[size] ?? 0;
  if (size !== 0 && huffSize === 0) {
    throw jpegError("DC Huffman size missing from table");
  }
  if (size === 0) {
    if (huffSize === 0) {
      throw jpegError("DC Huffman size missing from table");
    }
    w.writeBits(huffCode, huffSize);
    return;
  }
  w.writeBits(huffCode, huffSize);
  w.writeBits(additionalBits(v, size), size);
}

export function encodeAc(w: BitWriter, table: HuffmanEncode, zz: Int32Array): void {
  let zeros = 0;
  for (let i = 1; i < 64; i++) {
    let coef = zz[i] ?? 0;
    if (coef === 0) {
      zeros += 1;
      continue;
    }
    while (zeros >= 16) {
      writeSymbol(w, table, 0xf0);
      zeros -= 16;
    }
    if (coef > 1023) {
      coef = 1023;
    } else if (coef < -1023) {
      coef = -1023;
    }
    const size = bitSize(coef < 0 ? -coef : coef);
    writeSymbol(w, table, (zeros << 4) | size);
    w.writeBits(additionalBits(coef, size), size);
    zeros = 0;
  }
  if (zeros > 0) {
    writeSymbol(w, table, 0x00);
  }
}

export function decodeSymbol(r: BitReader, table: HuffmanDecode): number {
  let code = r.readBit();
  for (let i = 0; i < 16; i++) {
    const max = table.maxCode[i] ?? -1;
    if (max !== -1 && code <= max) {
      const min = table.minCode[i] ?? 0;
      const ptr = table.valPtr[i] ?? 0;
      const idx = ptr + code - min;
      const sym = table.huffVal[idx];
      if (sym === undefined) {
        throw jpegError("invalid Huffman symbol index");
      }
      return sym;
    }
    if (i === 15) {
      break;
    }
    code = (code << 1) | r.readBit();
  }
  throw jpegError("invalid Huffman code");
}

export function decodeDc(r: BitReader, table: HuffmanDecode, pred: number): number {
  const size = decodeSymbol(r, table);
  if (size < 0 || size > 11) {
    throw jpegError("invalid DC coefficient size");
  }
  const bits = r.readBits(size);
  return pred + extendBits(bits, size);
}

export function decodeAc(r: BitReader, table: HuffmanDecode, zz: Int32Array): void {
  let k = 1;
  while (k < 64) {
    const rs = decodeSymbol(r, table);
    const run = rs >> 4;
    const size = rs & 0x0f;
    if (size === 0) {
      if (run === 15) {
        k += 16;
        if (k > 64) {
          throw jpegError("AC coefficient overrun");
        }
        continue;
      }
      break;
    }
    k += run;
    if (k >= 64) {
      throw jpegError("AC coefficient overrun");
    }
    zz[k] = extendBits(r.readBits(size), size);
    k += 1;
  }
}
