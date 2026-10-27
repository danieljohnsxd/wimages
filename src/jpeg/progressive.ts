import type { BitReader } from "./bits.ts";
import { jpegError } from "./error.ts";
import { decodeSymbol, type HuffmanDecode } from "./huffman.ts";

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

/** Mutable progressive-scan state (EOB run + AC-refinement machine). */
export type ProgressiveScan = {
  ss: number;
  se: number;
  ah: number;
  al: number;
  eobrun: number;
  acState: number;
  acNext: number;
};

export function resetProgressiveScan(scan: ProgressiveScan): void {
  scan.eobrun = 0;
  scan.acState = 0;
  scan.acNext = 0;
}

/** DC first scan (Ss=0, Ah=0): Huffman DC, store `pred << Al`. Returns new pred. */
export function decodeDcFirst(
  bits: BitReader,
  table: HuffmanDecode,
  zz: Int16Array,
  pred: number,
  al: number,
): number {
  const size = decodeSymbol(bits, table);
  if (size < 0 || size > 11) {
    throw jpegError("invalid DC coefficient size");
  }
  const diff = extendBits(bits.readBits(size), size);
  const next = pred + diff;
  zz[0] = next << al;
  return next;
}

/** DC refinement (Ss=0, Ah≠0): append one bit at Al. */
export function decodeDcRefine(bits: BitReader, zz: Int16Array, al: number): void {
  const dc = zz[0] ?? 0;
  zz[0] = dc | (bits.readBit() << al);
}

/** AC first scan (Ah=0) with EOBn runs. */
export function decodeAcFirst(
  bits: BitReader,
  table: HuffmanDecode,
  zz: Int16Array,
  scan: ProgressiveScan,
): void {
  if (scan.eobrun > 0) {
    scan.eobrun -= 1;
    return;
  }
  let k = scan.ss < 1 ? 1 : scan.ss;
  const se = scan.se;
  const al = scan.al;
  while (k <= se) {
    const rs = decodeSymbol(bits, table);
    const run = rs >> 4;
    const size = rs & 0x0f;
    if (size === 0) {
      if (run === 15) {
        k += 16;
        continue;
      }
      scan.eobrun = bits.readBits(run) + (1 << run) - 1;
      break;
    }
    k += run;
    if (k > se || k >= 64) {
      throw jpegError("AC coefficient overrun");
    }
    zz[k] = extendBits(bits.readBits(size), size) << al;
    k += 1;
  }
}

/**
 * AC refinement (Ah≠0). State machine matches pdf.js `decodeACSuccessive`
 * / libjpeg `decode_mcu_AC_refine`.
 */
export function decodeAcRefine(
  bits: BitReader,
  table: HuffmanDecode,
  zz: Int16Array,
  scan: ProgressiveScan,
): void {
  let k = scan.ss < 1 ? 1 : scan.ss;
  const se = scan.se;
  const p1 = 1 << scan.al;
  let r = 0;
  while (k <= se) {
    const coef = zz[k] ?? 0;
    const sign = coef < 0 ? -1 : 1;
    switch (scan.acState) {
      case 0: {
        const rs = decodeSymbol(bits, table);
        const size = rs & 0x0f;
        r = rs >> 4;
        if (size === 0) {
          if (r < 15) {
            scan.eobrun = bits.readBits(r) + (1 << r);
            scan.acState = 4;
          } else {
            r = 16;
            scan.acState = 1;
          }
        } else {
          if (size !== 1) {
            throw jpegError("invalid AC refinement size");
          }
          scan.acNext = extendBits(bits.readBits(size), size);
          scan.acState = r !== 0 ? 2 : 3;
        }
        continue;
      }
      case 1:
      case 2:
        if (coef !== 0) {
          if (bits.readBit()) {
            zz[k] = coef + sign * p1;
          }
        } else {
          r -= 1;
          if (r === 0) {
            scan.acState = scan.acState === 2 ? 3 : 0;
          }
        }
        break;
      case 3:
        if (coef !== 0) {
          if (bits.readBit()) {
            zz[k] = coef + sign * p1;
          }
        } else {
          zz[k] = scan.acNext << scan.al;
          scan.acState = 0;
        }
        break;
      case 4:
        if (coef !== 0) {
          if (bits.readBit()) {
            zz[k] = coef + sign * p1;
          }
        }
        break;
      default:
        throw jpegError("invalid AC refinement state");
    }
    k += 1;
  }
  if (scan.acState === 4) {
    scan.eobrun -= 1;
    if (scan.eobrun === 0) {
      scan.acState = 0;
    }
  }
}
