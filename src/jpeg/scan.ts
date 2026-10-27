import { BitWriter, type ByteWriter } from "./bits.ts";
import { jpegError } from "./error.ts";
import { additionalBits, countAc, countDc, encodeTableFromFreq, magnitudeSize } from "./huffopt.ts";
import { encodeAc, encodeDc, type HuffmanEncode } from "./huffman.ts";
import { writeHuffmanTable, writeSos, type SosComponent } from "./markers.ts";

/**
 * One component's quantized coefficients in zigzag order, 64 Int16 per block.
 * `blockCols` is the MCU-padded row stride of `coeffs`. `scanCols`/`scanRows`
 * are T.81 A.2.2 non-interleaved extents (ceil(compWidth/8) × ceil(compHeight/8)).
 */
export type ComponentCoeffs = {
  readonly coeffs: Int16Array;
  readonly blockCols: number;
  readonly scanCols: number;
  readonly scanRows: number;
  readonly h: number;
  readonly v: number;
  readonly id: number;
  readonly dcTbl: number;
  readonly acTbl: number;
};

export type ScanSpec = {
  readonly comps: readonly number[];
  readonly ss: number;
  readonly se: number;
  readonly ah: number;
  readonly al: number;
};

function range(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(i);
  }
  return out;
}

/** libjpeg-turbo `jpeg_simple_progression` script for 3-component YCbCr. */
export const YCBCR_PROGRESSIVE_SCANS: readonly ScanSpec[] = [
  { comps: [0, 1, 2], ss: 0, se: 0, ah: 0, al: 1 },
  { comps: [0], ss: 1, se: 5, ah: 0, al: 2 },
  { comps: [2], ss: 1, se: 63, ah: 0, al: 1 },
  { comps: [1], ss: 1, se: 63, ah: 0, al: 1 },
  { comps: [0], ss: 6, se: 63, ah: 0, al: 2 },
  { comps: [0], ss: 1, se: 63, ah: 2, al: 1 },
  { comps: [0, 1, 2], ss: 0, se: 0, ah: 1, al: 0 },
  { comps: [2], ss: 1, se: 63, ah: 1, al: 0 },
  { comps: [1], ss: 1, se: 63, ah: 1, al: 0 },
  { comps: [0], ss: 1, se: 63, ah: 1, al: 0 },
];

/** libjpeg-turbo `jpeg_simple_progression` grayscale (ncomps == 1) script. */
export const GRAY_PROGRESSIVE_SCANS: readonly ScanSpec[] = [
  { comps: [0], ss: 0, se: 0, ah: 0, al: 1 },
  { comps: [0], ss: 1, se: 5, ah: 0, al: 2 },
  { comps: [0], ss: 6, se: 63, ah: 0, al: 2 },
  { comps: [0], ss: 1, se: 63, ah: 2, al: 1 },
  { comps: [0], ss: 0, se: 0, ah: 1, al: 0 },
  { comps: [0], ss: 1, se: 63, ah: 1, al: 0 },
];

/**
 * YCbCr 10-scan script with a 4th component treated as chroma (after Cb).
 * Not the generic 4-component all-purpose script.
 */
export const CMYK_PROGRESSIVE_SCANS: readonly ScanSpec[] = [
  { comps: [0, 1, 2, 3], ss: 0, se: 0, ah: 0, al: 1 },
  { comps: [0], ss: 1, se: 5, ah: 0, al: 2 },
  { comps: [2], ss: 1, se: 63, ah: 0, al: 1 },
  { comps: [1], ss: 1, se: 63, ah: 0, al: 1 },
  { comps: [3], ss: 1, se: 63, ah: 0, al: 1 },
  { comps: [0], ss: 6, se: 63, ah: 0, al: 2 },
  { comps: [0], ss: 1, se: 63, ah: 2, al: 1 },
  { comps: [0, 1, 2, 3], ss: 0, se: 0, ah: 1, al: 0 },
  { comps: [2], ss: 1, se: 63, ah: 1, al: 0 },
  { comps: [1], ss: 1, se: 63, ah: 1, al: 0 },
  { comps: [3], ss: 1, se: 63, ah: 1, al: 0 },
  { comps: [0], ss: 1, se: 63, ah: 1, al: 0 },
];

/** Sequential interleaved scan covering every coefficient. */
export function sequentialScan(nComponents: number): ScanSpec {
  return { comps: range(nComponents), ss: 0, se: 63, ah: 0, al: 0 };
}

export function progressiveScansFor(nComponents: number): readonly ScanSpec[] {
  if (nComponents === 1) {
    return GRAY_PROGRESSIVE_SCANS;
  }
  if (nComponents === 3) {
    return YCBCR_PROGRESSIVE_SCANS;
  }
  if (nComponents === 4) {
    return CMYK_PROGRESSIVE_SCANS;
  }
  throw jpegError(`unsupported component count ${nComponents}`);
}

const MAX_CORR_BITS = 1000;

function blockAt(comp: ComponentCoeffs, bx: number, by: number): Int16Array {
  const off = (by * comp.blockCols + bx) * 64;
  return comp.coeffs.subarray(off, off + 64);
}

function requireComp(comps: readonly ComponentCoeffs[], idx: number): ComponentCoeffs {
  const comp = comps[idx];
  if (comp === undefined) {
    throw jpegError("progressive scan component is missing");
  }
  return comp;
}

function pointTransformAc(coef: number, al: number): number {
  if (al === 0) {
    return coef;
  }
  return coef < 0 ? -(-coef >> al) : coef >> al;
}

type HuffTables = Array<HuffmanEncode | undefined>;

type Emit = {
  symbol: (tbl: number, sym: number) => void;
  bits: (value: number, n: number) => void;
};

type BlockVisitor = (comp: ComponentCoeffs, ci: number, block: Int16Array) => void;

/**
 * T.81 A.2: Ns>1 walks the MCU grid (dummy blocks included). Ns=1 walks the
 * component's own unpadded block raster, still indexed with the padded stride.
 */
function eachDataUnit(
  comps: readonly ComponentCoeffs[],
  scanComps: readonly number[],
  mcuCols: number,
  mcuRows: number,
  visit: BlockVisitor,
): void {
  if (scanComps.length === 1) {
    const comp = requireComp(comps, scanComps[0] ?? 0);
    for (let by = 0; by < comp.scanRows; by++) {
      for (let bx = 0; bx < comp.scanCols; bx++) {
        visit(comp, 0, blockAt(comp, bx, by));
      }
    }
    return;
  }
  for (let my = 0; my < mcuRows; my++) {
    for (let mx = 0; mx < mcuCols; mx++) {
      for (let ci = 0; ci < scanComps.length; ci++) {
        const comp = requireComp(comps, scanComps[ci] ?? 0);
        for (let vy = 0; vy < comp.v; vy++) {
          for (let hx = 0; hx < comp.h; hx++) {
            visit(comp, ci, blockAt(comp, mx * comp.h + hx, my * comp.v + vy));
          }
        }
      }
    }
  }
}

function makeCountEmit(freqs: Array<Uint32Array | undefined>): Emit {
  return {
    symbol(tbl: number, sym: number): void {
      const freq = freqs[tbl];
      if (freq === undefined) {
        throw jpegError("progressive scan is missing a Huffman count table");
      }
      freq[sym] = (freq[sym] ?? 0) + 1;
    },
    bits(_value: number, _n: number): void {},
  };
}

function makeWriteEmit(bits: BitWriter, tables: HuffTables): Emit {
  return {
    symbol(tbl: number, sym: number): void {
      const table = tables[tbl];
      if (table === undefined) {
        throw jpegError("progressive scan is missing a Huffman table");
      }
      const size = table.sizes[sym] ?? 0;
      const code = table.codes[sym] ?? 0;
      if (size === 0) {
        throw jpegError(`Huffman symbol 0x${sym.toString(16)} is not in the table`);
      }
      bits.writeBits(code, size);
    },
    bits(value: number, n: number): void {
      bits.writeBits(value, n);
    },
  };
}

class AcState {
  eobRun = 0;
  be = 0;
  readonly corr = new Uint8Array(MAX_CORR_BITS);
  acTbl = 0;

  emitEobRun(emit: Emit): void {
    if (this.eobRun === 0) {
      return;
    }
    let temp = this.eobRun;
    let nbits = 0;
    while (temp > 1) {
      nbits += 1;
      temp >>= 1;
    }
    emit.symbol(this.acTbl, nbits << 4);
    if (nbits > 0) {
      emit.bits(this.eobRun, nbits);
    }
    this.eobRun = 0;
    for (let i = 0; i < this.be; i++) {
      emit.bits(this.corr[i] ?? 0, 1);
    }
    this.be = 0;
  }
}

function encodeDcFirst(
  emit: Emit,
  comps: readonly ComponentCoeffs[],
  scanComps: readonly number[],
  mcuCols: number,
  mcuRows: number,
  al: number,
): void {
  const last = new Int32Array(scanComps.length);
  eachDataUnit(comps, scanComps, mcuCols, mcuRows, (comp, ci, block) => {
    const dc = (block[0] ?? 0) >> al;
    const diff = dc - (last[ci] ?? 0);
    last[ci] = dc;
    const size = magnitudeSize(diff);
    emit.symbol(comp.dcTbl, size);
    if (size > 0) {
      emit.bits(additionalBits(diff, size), size);
    }
  });
}

function encodeDcRefine(
  emit: Emit,
  comps: readonly ComponentCoeffs[],
  scanComps: readonly number[],
  mcuCols: number,
  mcuRows: number,
  al: number,
): void {
  eachDataUnit(comps, scanComps, mcuCols, mcuRows, (_comp, _ci, block) => {
    emit.bits((block[0] ?? 0) >> al, 1);
  });
}

function encodeAcFirstBlock(
  emit: Emit,
  block: Int16Array,
  ss: number,
  se: number,
  al: number,
  ac: AcState,
): void {
  let r = 0;
  for (let k = ss; k <= se; k++) {
    const v = pointTransformAc(block[k] ?? 0, al);
    if (v === 0) {
      r += 1;
      continue;
    }
    ac.emitEobRun(emit);
    while (r > 15) {
      emit.symbol(ac.acTbl, 0xf0);
      r -= 16;
    }
    const size = magnitudeSize(v);
    emit.symbol(ac.acTbl, (r << 4) | size);
    emit.bits(additionalBits(v, size), size);
    r = 0;
  }
  if (r > 0) {
    ac.eobRun += 1;
    if (ac.eobRun === 0x7fff) {
      ac.emitEobRun(emit);
    }
  }
}

function encodeAcFirst(
  emit: Emit,
  comp: ComponentCoeffs,
  ss: number,
  se: number,
  al: number,
): void {
  const ac = new AcState();
  ac.acTbl = comp.acTbl;
  for (let by = 0; by < comp.scanRows; by++) {
    for (let bx = 0; bx < comp.scanCols; bx++) {
      encodeAcFirstBlock(emit, blockAt(comp, bx, by), ss, se, al, ac);
    }
  }
  ac.emitEobRun(emit);
}

function encodeAcRefineBlock(
  emit: Emit,
  block: Int16Array,
  ss: number,
  se: number,
  al: number,
  ac: AcState,
): void {
  let eob = ss - 1;
  const absv = new Int32Array(64);
  for (let k = ss; k <= se; k++) {
    const v = pointTransformAc(block[k] ?? 0, al);
    const a = v < 0 ? -v : v;
    absv[k] = a;
    if (a === 1) {
      eob = k;
    }
  }

  let r = 0;
  let br = 0;
  let brOff = ac.be;

  const emitCorr = (off: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      emit.bits(ac.corr[off + i] ?? 0, 1);
    }
  };

  for (let k = ss; k <= se; k++) {
    const temp = absv[k] ?? 0;
    if (temp === 0) {
      r += 1;
      continue;
    }
    // libjpeg's `while (r > 15 && k <= EOB)`; the second test is loop-invariant.
    if (k <= eob) {
      while (r > 15) {
        ac.emitEobRun(emit);
        emit.symbol(ac.acTbl, 0xf0);
        r -= 16;
        emitCorr(brOff, br);
        brOff = 0;
        br = 0;
      }
    }
    if (temp > 1) {
      ac.corr[brOff + br] = temp & 1;
      br += 1;
      continue;
    }
    ac.emitEobRun(emit);
    emit.symbol(ac.acTbl, (r << 4) | 1);
    emit.bits((block[k] ?? 0) < 0 ? 0 : 1, 1);
    emitCorr(brOff, br);
    brOff = 0;
    br = 0;
    r = 0;
  }

  if (r > 0 || br > 0) {
    ac.eobRun += 1;
    ac.be += br;
    if (ac.eobRun === 0x7fff || ac.be > MAX_CORR_BITS - 64 + 1) {
      ac.emitEobRun(emit);
    }
  }
}

function encodeAcRefine(
  emit: Emit,
  comp: ComponentCoeffs,
  ss: number,
  se: number,
  al: number,
): void {
  const ac = new AcState();
  ac.acTbl = comp.acTbl;
  for (let by = 0; by < comp.scanRows; by++) {
    for (let bx = 0; bx < comp.scanCols; bx++) {
      encodeAcRefineBlock(emit, blockAt(comp, bx, by), ss, se, al, ac);
    }
  }
  ac.emitEobRun(emit);
}

function runScan(
  emit: Emit,
  comps: readonly ComponentCoeffs[],
  scan: ScanSpec,
  mcuCols: number,
  mcuRows: number,
): void {
  if (scan.ss === 0) {
    if (scan.ah === 0) {
      encodeDcFirst(emit, comps, scan.comps, mcuCols, mcuRows, scan.al);
    } else {
      encodeDcRefine(emit, comps, scan.comps, mcuCols, mcuRows, scan.al);
    }
    return;
  }
  if (scan.comps.length !== 1) {
    throw jpegError("progressive AC scan must have one component");
  }
  const comp = requireComp(comps, scan.comps[0] ?? 0);
  if (scan.ah === 0) {
    encodeAcFirst(emit, comp, scan.ss, scan.se, scan.al);
  } else {
    encodeAcRefine(emit, comp, scan.ss, scan.se, scan.al);
  }
}

function sosComps(comps: readonly ComponentCoeffs[], scan: ScanSpec): SosComponent[] {
  const out: SosComponent[] = [];
  for (const idx of scan.comps) {
    const c = requireComp(comps, idx);
    out.push({ id: c.id, dc: c.dcTbl, ac: c.acTbl });
  }
  return out;
}

function scanNeedsDc(scan: ScanSpec): boolean {
  return scan.ss === 0 && scan.ah === 0;
}

function scanNeedsAc(scan: ScanSpec): boolean {
  return scan.se > 0;
}

function writeScanDht(
  out: ByteWriter,
  comps: readonly ComponentCoeffs[],
  scan: ScanSpec,
  dcFreq: Array<Uint32Array | undefined>,
  acFreq: Array<Uint32Array | undefined>,
): HuffTables {
  const tables: HuffTables = [];
  const wroteDc = [false, false, false, false];
  const wroteAc = [false, false, false, false];
  if (!scanNeedsDc(scan) && !scanNeedsAc(scan)) {
    return tables;
  }
  const writeDc = (tbl: number): void => {
    if (wroteDc[tbl] === true) {
      return;
    }
    wroteDc[tbl] = true;
    const freq = dcFreq[tbl];
    if (freq === undefined) {
      throw jpegError("progressive DC frequency table is missing");
    }
    const built = encodeTableFromFreq(freq);
    tables[tbl] = built.encode;
    writeHuffmanTable(out, tbl, built.dht.bits, built.dht.vals);
  };
  const writeAc = (tbl: number): void => {
    if (wroteAc[tbl] === true) {
      return;
    }
    wroteAc[tbl] = true;
    const freq = acFreq[tbl];
    if (freq === undefined) {
      throw jpegError("progressive AC frequency table is missing");
    }
    const built = encodeTableFromFreq(freq);
    tables[tbl] = built.encode;
    writeHuffmanTable(out, 0x10 | tbl, built.dht.bits, built.dht.vals);
  };
  for (const idx of scan.comps) {
    const c = comps[idx];
    if (c === undefined) {
      continue;
    }
    if (scanNeedsDc(scan)) {
      writeDc(c.dcTbl);
    }
    if (scanNeedsAc(scan) && !scanNeedsDc(scan)) {
      writeAc(c.acTbl);
    }
  }
  return tables;
}

function encodeScans(
  out: ByteWriter,
  comps: readonly ComponentCoeffs[],
  mcuCols: number,
  mcuRows: number,
  scans: readonly ScanSpec[],
): void {
  for (const scan of scans) {
    const dcFreq: Array<Uint32Array | undefined> = [];
    const acFreq: Array<Uint32Array | undefined> = [];
    if (scanNeedsDc(scan) || scanNeedsAc(scan)) {
      for (const idx of scan.comps) {
        const c = comps[idx];
        if (c === undefined) {
          continue;
        }
        if (scanNeedsDc(scan) && dcFreq[c.dcTbl] === undefined) {
          dcFreq[c.dcTbl] = new Uint32Array(257);
        }
        if (scanNeedsAc(scan) && !scanNeedsDc(scan) && acFreq[c.acTbl] === undefined) {
          acFreq[c.acTbl] = new Uint32Array(257);
        }
      }
      const freqs = scanNeedsDc(scan) ? dcFreq : acFreq;
      runScan(makeCountEmit(freqs), comps, scan, mcuCols, mcuRows);
    }
    const tables = writeScanDht(out, comps, scan, dcFreq, acFreq);
    writeSos(out, sosComps(comps, scan), scan.ss, scan.se, scan.ah, scan.al);
    const bits = new BitWriter();
    runScan(makeWriteEmit(bits, tables), comps, scan, mcuCols, mcuRows);
    out.writeBytes(bits.finish());
  }
}

/** Emit per-scan DHT + SOS + entropy for a progressive script (YCbCr default). */
export function encodeProgressiveScans(
  out: ByteWriter,
  comps: readonly ComponentCoeffs[],
  mcuCols: number,
  mcuRows: number,
  scans: readonly ScanSpec[] = YCBCR_PROGRESSIVE_SCANS,
): void {
  encodeScans(out, comps, mcuCols, mcuRows, scans);
}

function loadBlock(src: Int16Array, zz: Int32Array): void {
  for (let i = 0; i < 64; i++) {
    zz[i] = src[i] ?? 0;
  }
}

/**
 * Two-pass optimized Huffman sequential scan (interleaved, all coefficients).
 * DHT order is DC0, AC0, DC1, AC1, … for every table id actually used.
 */
export function encodeSequentialScans(
  out: ByteWriter,
  comps: readonly ComponentCoeffs[],
  mcuCols: number,
  mcuRows: number,
): void {
  const dcFreq: Array<Uint32Array | undefined> = [];
  const acFreq: Array<Uint32Array | undefined> = [];
  for (const c of comps) {
    if (dcFreq[c.dcTbl] === undefined) {
      dcFreq[c.dcTbl] = new Uint32Array(257);
    }
    if (acFreq[c.acTbl] === undefined) {
      acFreq[c.acTbl] = new Uint32Array(257);
    }
  }
  const scan = sequentialScan(comps.length);
  const zz = new Int32Array(64);
  const last = new Int32Array(scan.comps.length);
  eachDataUnit(comps, scan.comps, mcuCols, mcuRows, (comp, ci, block) => {
    loadBlock(block, zz);
    const dc = zz[0] ?? 0;
    const dcF = dcFreq[comp.dcTbl];
    const acF = acFreq[comp.acTbl];
    if (dcF === undefined || acF === undefined) {
      throw jpegError("sequential frequency table is missing");
    }
    countDc(dcF, dc - (last[ci] ?? 0));
    countAc(acF, zz);
    last[ci] = dc;
  });

  const dcEnc: HuffTables = [];
  const acEnc: HuffTables = [];
  const used = new Set<number>();
  for (const c of comps) {
    used.add(c.dcTbl);
    used.add(c.acTbl);
  }
  const ids = [...used];
  ids.sort((a, b) => a - b);
  for (const id of ids) {
    const df = dcFreq[id];
    const af = acFreq[id];
    if (df !== undefined) {
      const built = encodeTableFromFreq(df);
      dcEnc[id] = built.encode;
      writeHuffmanTable(out, id, built.dht.bits, built.dht.vals);
    }
    if (af !== undefined) {
      const built = encodeTableFromFreq(af);
      acEnc[id] = built.encode;
      writeHuffmanTable(out, 0x10 | id, built.dht.bits, built.dht.vals);
    }
  }

  writeSos(out, sosComps(comps, scan), 0, 63, 0, 0);
  const bits = new BitWriter();
  last.fill(0);
  eachDataUnit(comps, scan.comps, mcuCols, mcuRows, (comp, ci, block) => {
    loadBlock(block, zz);
    const dc = zz[0] ?? 0;
    const dcTbl = dcEnc[comp.dcTbl];
    const acTbl = acEnc[comp.acTbl];
    if (dcTbl === undefined || acTbl === undefined) {
      throw jpegError("sequential Huffman table is missing");
    }
    encodeDc(bits, dcTbl, dc - (last[ci] ?? 0));
    encodeAc(bits, acTbl, zz);
    last[ci] = dc;
  });
  out.writeBytes(bits.finish());
}
