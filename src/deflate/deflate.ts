import { BitWriter } from "./bits.ts";
import { codeLengthsFromFreq, makeTable, rleCodeLengths, type HuffmanTable } from "./huffman.ts";
import { lz77, lz77Config, type Token } from "./lz77.ts";
import {
  CL_ORDER,
  distanceSymbol,
  fixedDistLengths,
  fixedLitLenLengths,
  lengthSymbol,
} from "./tables.ts";

const STORED_MAX = 65535;
const LITLEN_SYMS = 286;
const DIST_SYMS = 30;
const EOB = 256;

function trimTrailingZeros(lengths: Uint8Array, minKeep: number): Uint8Array {
  let n = lengths.length;
  while (n > minKeep && (lengths[n - 1] ?? 0) === 0) {
    n -= 1;
  }
  return lengths.subarray(0, n);
}

/** RFC 1951: a block with no matches still emits one distance code of length 1. */
function ensureDistanceCode(dist: Uint8Array): void {
  for (let i = 0; i < dist.length; i++) {
    if ((dist[i] ?? 0) > 0) {
      return;
    }
  }
  dist[0] = 1;
}

function distLengthsForHeader(dist: Uint8Array): Uint8Array {
  const used = trimTrailingZeros(dist, 1);
  for (let i = 0; i < used.length; i++) {
    if ((used[i] ?? 0) > 0) {
      return used;
    }
  }
  return new Uint8Array([1]);
}

function writeSymbol(w: BitWriter, table: HuffmanTable, sym: number): void {
  const len = table.lengths[sym] ?? 0;
  const code = table.codes[sym] ?? 0;
  if (len === 0) {
    throw new Error("deflate: missing Huffman code");
  }
  w.writeBits(code, len);
}

function writeTokens(
  w: BitWriter,
  tokens: readonly Token[],
  lit: HuffmanTable,
  dist: HuffmanTable,
): void {
  for (const token of tokens) {
    if (token.kind === "lit") {
      writeSymbol(w, lit, token.value);
      continue;
    }
    const ls = lengthSymbol(token.length);
    writeSymbol(w, lit, ls.sym);
    if (ls.extraBits > 0) {
      w.writeBits(ls.extra, ls.extraBits);
    }
    const ds = distanceSymbol(token.distance);
    writeSymbol(w, dist, ds.sym);
    if (ds.extraBits > 0) {
      w.writeBits(ds.extra, ds.extraBits);
    }
  }
  writeSymbol(w, lit, EOB);
}

function tokenBits(tokens: readonly Token[], lit: HuffmanTable, dist: HuffmanTable): number {
  let bits = lit.lengths[EOB] ?? 0;
  for (const token of tokens) {
    if (token.kind === "lit") {
      bits += lit.lengths[token.value] ?? 0;
      continue;
    }
    const ls = lengthSymbol(token.length);
    const ds = distanceSymbol(token.distance);
    bits += (lit.lengths[ls.sym] ?? 0) + ls.extraBits;
    bits += (dist.lengths[ds.sym] ?? 0) + ds.extraBits;
  }
  return bits;
}

function countFreqs(tokens: readonly Token[]): {
  readonly lit: Uint32Array;
  readonly dist: Uint32Array;
} {
  const lit = new Uint32Array(LITLEN_SYMS);
  const dist = new Uint32Array(DIST_SYMS);
  lit[EOB] = 1;
  for (const token of tokens) {
    if (token.kind === "lit") {
      lit[token.value] = (lit[token.value] ?? 0) + 1;
    } else {
      const ls = lengthSymbol(token.length);
      const ds = distanceSymbol(token.distance);
      lit[ls.sym] = (lit[ls.sym] ?? 0) + 1;
      dist[ds.sym] = (dist[ds.sym] ?? 0) + 1;
    }
  }
  return { lit, dist };
}

function writeDynamicHeader(
  w: BitWriter,
  litLen: Uint8Array,
  dist: Uint8Array,
): { readonly lit: HuffmanTable; readonly dist: HuffmanTable } {
  const litUsed = trimTrailingZeros(litLen, 257);
  const distUsed = distLengthsForHeader(dist);

  const hlit = litUsed.length - 257;
  const hdist = distUsed.length - 1;

  const combined = new Uint8Array(litUsed.length + distUsed.length);
  combined.set(litUsed);
  combined.set(distUsed, litUsed.length);
  const rle = rleCodeLengths(combined);

  const clFreq = new Uint32Array(19);
  for (let i = 0; i < rle.length;) {
    const sym = rle[i] ?? 0;
    clFreq[sym] = (clFreq[sym] ?? 0) + 1;
    if (sym === 16 || sym === 17 || sym === 18) {
      i += 2;
    } else {
      i += 1;
    }
  }

  const clLen = codeLengthsFromFreq(clFreq, 7, 2);
  let clCount = 4;
  for (let i = 0; i < CL_ORDER.length; i++) {
    const sym = CL_ORDER[i] ?? 0;
    if ((clLen[sym] ?? 0) > 0) {
      clCount = i + 1;
    }
  }
  if (clCount < 4) {
    clCount = 4;
  }

  const clTable = makeTable(clLen);
  w.writeBits(hlit, 5);
  w.writeBits(hdist, 5);
  w.writeBits(clCount - 4, 4);
  for (let i = 0; i < clCount; i++) {
    const sym = CL_ORDER[i] ?? 0;
    w.writeBits(clLen[sym] ?? 0, 3);
  }

  for (let i = 0; i < rle.length;) {
    const sym = rle[i] ?? 0;
    writeSymbol(w, clTable, sym);
    if (sym === 16) {
      w.writeBits(rle[i + 1] ?? 0, 2);
      i += 2;
    } else if (sym === 17) {
      w.writeBits(rle[i + 1] ?? 0, 3);
      i += 2;
    } else if (sym === 18) {
      w.writeBits(rle[i + 1] ?? 0, 7);
      i += 2;
    } else {
      i += 1;
    }
  }

  const litFull = new Uint8Array(LITLEN_SYMS);
  litFull.set(litUsed);
  const distFull = new Uint8Array(DIST_SYMS);
  distFull.set(distUsed);
  return { lit: makeTable(litFull), dist: makeTable(distFull) };
}

function dynamicHeaderBits(litLen: Uint8Array, dist: Uint8Array): number {
  const litUsed = trimTrailingZeros(litLen, 257);
  const distUsed = distLengthsForHeader(dist);
  const combined = new Uint8Array(litUsed.length + distUsed.length);
  combined.set(litUsed);
  combined.set(distUsed, litUsed.length);
  const rle = rleCodeLengths(combined);
  const clFreq = new Uint32Array(19);
  let extra = 0;
  for (let i = 0; i < rle.length;) {
    const sym = rle[i] ?? 0;
    clFreq[sym] = (clFreq[sym] ?? 0) + 1;
    if (sym === 16) {
      extra += 2;
      i += 2;
    } else if (sym === 17) {
      extra += 3;
      i += 2;
    } else if (sym === 18) {
      extra += 7;
      i += 2;
    } else {
      i += 1;
    }
  }
  const clLen = codeLengthsFromFreq(clFreq, 7, 2);
  let clCount = 4;
  for (let i = 0; i < CL_ORDER.length; i++) {
    const sym = CL_ORDER[i] ?? 0;
    if ((clLen[sym] ?? 0) > 0) {
      clCount = i + 1;
    }
  }
  let bits = 5 + 5 + 4 + clCount * 3 + extra;
  for (let i = 0; i < rle.length;) {
    const sym = rle[i] ?? 0;
    bits += clLen[sym] ?? 0;
    i += sym === 16 || sym === 17 || sym === 18 ? 2 : 1;
  }
  return bits;
}

function writeStored(w: BitWriter, data: Uint8Array, final: boolean): void {
  let offset = 0;
  while (offset < data.length || (offset === 0 && data.length === 0)) {
    const remaining = data.length - offset;
    const take = remaining > STORED_MAX ? STORED_MAX : remaining;
    const last = final && offset + take >= data.length;
    w.writeBits(last ? 1 : 0, 1);
    w.writeBits(0, 2);
    w.writeUint16LE(take);
    w.writeUint16LE(~take & 0xffff);
    w.writeBytes(data.subarray(offset, offset + take));
    offset += take;
    if (data.length === 0) {
      break;
    }
  }
}

function writeCompressedBlock(
  w: BitWriter,
  data: Uint8Array,
  tokens: readonly Token[],
  final: boolean,
): void {
  const freqs = countFreqs(tokens);
  const dynLitLen = codeLengthsFromFreq(freqs.lit, 15);
  const dynDist = codeLengthsFromFreq(freqs.dist, 15);
  ensureDistanceCode(dynDist);

  const dynLitTable = makeTable(dynLitLen);
  const dynDistTable = makeTable(dynDist);
  const dynBits =
    3 + dynamicHeaderBits(dynLitLen, dynDist) + tokenBits(tokens, dynLitTable, dynDistTable);

  const fixLit = makeTable(fixedLitLenLengths());
  const fixDist = makeTable(fixedDistLengths());
  const fixBits = 3 + tokenBits(tokens, fixLit, fixDist);

  const storedBits = 3 + 32 + data.length * 8 + 7;

  if (storedBits <= dynBits && storedBits <= fixBits) {
    writeStored(w, data, final);
    return;
  }

  if (fixBits <= dynBits) {
    w.writeBits(final ? 1 : 0, 1);
    w.writeBits(1, 2);
    writeTokens(w, tokens, fixLit, fixDist);
    return;
  }

  w.writeBits(final ? 1 : 0, 1);
  w.writeBits(2, 2);
  const tables = writeDynamicHeader(w, dynLitLen, dynDist);
  writeTokens(w, tokens, tables.lit, tables.dist);
}

const BLOCK = 32768;

/** Raw deflate (no zlib wrapper). */
export function deflateRaw(data: Uint8Array, level: number): Uint8Array {
  const w = new BitWriter();
  if (level <= 0) {
    writeStored(w, data, true);
    return w.finish();
  }

  const config = lz77Config(level);
  if (data.length === 0) {
    writeStored(w, data, true);
    return w.finish();
  }

  let offset = 0;
  while (offset < data.length) {
    const end = offset + BLOCK < data.length ? offset + BLOCK : data.length;
    const slice = data.subarray(offset, end);
    const tokens = lz77(slice, config);
    writeCompressedBlock(w, slice, tokens, end === data.length);
    offset = end;
  }
  return w.finish();
}
