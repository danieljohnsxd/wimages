import type { DecodeLimits } from "../limits.ts";
import type { PixelBuffer } from "../pixels.ts";
import { BitReader } from "./bits.ts";
import {
  checkJpegBudget,
  parseSofHeader,
  precisionMessage,
  unsupportedSofMessage,
} from "./budget.ts";
import { ycbcrToRgb } from "./color.ts";
import { idct8 } from "./dct.ts";
import { jpegError, jpegRangeError } from "./error.ts";
import { applyOrientation, parseExifOrientation } from "./exif.ts";
import { buildDecodeTable, decodeAc, decodeDc, type HuffmanDecode } from "./huffman.ts";
import {
  decodeAcFirst,
  decodeAcRefine,
  decodeDcFirst,
  decodeDcRefine,
  resetProgressiveScan,
  type ProgressiveScan,
} from "./progressive.ts";
import { ZIGZAG } from "./tables.ts";
import { upsampleComponentRow } from "./upsample.ts";

export type JpegDecodeOptions = DecodeLimits & {
  /** Default `"apply"`: rotate/flip RGBA using EXIF tag 0x0112. */
  readonly orientation?: "apply" | "ignore";
  /**
   * Chroma reconstruction. Default `"fancy"` is libjpeg-turbo's triangle filter
   * (h2v1 / h2v2 / h1v2). `"nearest"` replicates samples (`djpeg -nosmooth`).
   */
  readonly upsample?: "fancy" | "nearest";
};

export type JpegQuantTable = {
  readonly precision: 0 | 1;
  readonly values: Uint16Array;
};

export type JpegCoeffComponent = {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly qTable: number;
  readonly blocksW: number;
  readonly blocksH: number;
  readonly scanBlocksW: number;
  readonly scanBlocksH: number;
  /** Zigzag-order quantized coefficients, MCU-padded block grid. */
  readonly coeffs: Int16Array;
};

export type JpegCoefficients = {
  readonly width: number;
  readonly height: number;
  readonly progressive: boolean;
  readonly maxH: number;
  readonly maxV: number;
  readonly mcuCols: number;
  readonly mcuRows: number;
  readonly components: readonly JpegCoeffComponent[];
  readonly quantTables: ReadonlyArray<JpegQuantTable | undefined>;
  readonly orientation: number;
  readonly adobe: number | undefined;
  /** Original Adobe APP14 payload, copied verbatim on transcode. */
  readonly adobeBytes: Uint8Array | undefined;
};

/**
 * Scans per image. Every scan walks the whole block grid, so the scan count is a
 * CPU multiplier an attacker gets for ~10 bytes each. A real progressive file
 * has ~10 (libjpeg-turbo's default script); libjpeg-turbo's fuzz harnesses set
 * `TJPARAM_SCANLIMIT` to 100 and we use the same number.
 */
const MAX_SCANS = 100;

type Component = {
  id: number;
  h: number;
  v: number;
  qTable: number;
  dcTable: number;
  acTable: number;
  pred: number;
  /** MCU-padded block grid (interleaved scans write here). */
  blocksW: number;
  blocksH: number;
  /** Non-interleaved raster: ceil(compWidth/8) × ceil(compHeight/8). */
  scanBlocksW: number;
  scanBlocksH: number;
  coeffs: Int16Array;
};

type PlaneComponent = JpegCoeffComponent & {
  planeW: number;
  planeH: number;
  plane: Uint8Array;
};

type Frame = {
  width: number;
  height: number;
  progressive: boolean;
  maxH: number;
  maxV: number;
  mcuCols: number;
  mcuRows: number;
  components: Component[];
};

function u8(data: Uint8Array, i: number): number {
  const v = data[i];
  if (v === undefined) {
    throw jpegError("truncated");
  }
  return v;
}

function readUint16(data: Uint8Array, offset: number): number {
  return (u8(data, offset) << 8) | u8(data, offset + 1);
}

function skipFill(data: Uint8Array, pos: number): number {
  let i = pos;
  while (i < data.length && data[i] === 0xff) {
    i += 1;
  }
  return i;
}

function clamp8(x: number): number {
  const r = Math.round(x);
  if (r < 0) {
    return 0;
  }
  if (r > 255) {
    return 255;
  }
  return r;
}

function dequantIdct(zz: ArrayLike<number>, quant: Uint16Array, scratch: Float64Array): void {
  scratch.fill(0);
  for (let i = 0; i < 64; i++) {
    const n = ZIGZAG[i] ?? 0;
    scratch[n] = (zz[i] ?? 0) * (quant[n] ?? 1);
  }
  idct8(scratch);
}

function blitU8(
  plane: Uint8Array,
  planeW: number,
  blockX: number,
  blockY: number,
  block: Float64Array,
): void {
  const px = blockX * 8;
  const py = blockY * 8;
  for (let row = 0; row < 8; row++) {
    const dst = (py + row) * planeW + px;
    const src = row * 8;
    for (let col = 0; col < 8; col++) {
      plane[dst + col] = clamp8((block[src + col] ?? 0) + 128);
    }
  }
}

function coeffBlock(comp: Component, bx: number, by: number): Int16Array {
  const i = (by * comp.blocksW + bx) * 64;
  return comp.coeffs.subarray(i, i + 64);
}

function parseDqt(payload: Uint8Array, qTables: Array<JpegQuantTable | undefined>): void {
  let i = 0;
  while (i < payload.length) {
    const info = u8(payload, i);
    i += 1;
    const id = info & 0x0f;
    const precision = info >> 4;
    if (precision !== 0 && precision !== 1) {
      throw jpegError("invalid quantization table precision");
    }
    const sampleBytes = precision === 0 ? 1 : 2;
    if (i + 64 * sampleBytes > payload.length) {
      throw jpegError("truncated DQT");
    }
    const values = new Uint16Array(64);
    for (let k = 0; k < 64; k++) {
      const n = ZIGZAG[k] ?? 0;
      if (precision === 0) {
        values[n] = u8(payload, i);
        i += 1;
      } else {
        values[n] = readUint16(payload, i);
        i += 2;
      }
    }
    qTables[id] = { precision: precision === 0 ? 0 : 1, values };
  }
}

function parseDht(
  payload: Uint8Array,
  dcTables: Array<HuffmanDecode | undefined>,
  acTables: Array<HuffmanDecode | undefined>,
): void {
  let i = 0;
  while (i < payload.length) {
    const info = u8(payload, i);
    i += 1;
    const id = info & 0x0f;
    const cls = info >> 4;
    if (i + 16 > payload.length) {
      throw jpegError("truncated DHT");
    }
    const bits = payload.subarray(i, i + 16);
    i += 16;
    let nsym = 0;
    for (let b = 0; b < 16; b++) {
      nsym += bits[b] ?? 0;
    }
    if (i + nsym > payload.length) {
      throw jpegError("truncated DHT");
    }
    const vals = payload.subarray(i, i + nsym);
    i += nsym;
    const table = buildDecodeTable(bits, vals);
    if (cls === 0) {
      dcTables[id] = table;
    } else {
      acTables[id] = table;
    }
  }
}

function parseSof(payload: Uint8Array, progressive: boolean, maxPixels: number | undefined): Frame {
  const sof = parseSofHeader(payload);
  if (sof.precision !== 8) {
    throw jpegError(precisionMessage(sof.precision));
  }
  checkJpegBudget(sof, maxPixels);
  const components: Component[] = sof.components.map((c) => ({
    id: c.id,
    h: c.h,
    v: c.v,
    qTable: c.qTable,
    dcTable: 0,
    acTable: 0,
    pred: 0,
    blocksW: c.blocksW,
    blocksH: c.blocksH,
    scanBlocksW: c.scanBlocksW,
    scanBlocksH: c.scanBlocksH,
    coeffs: new Int16Array(0),
  }));
  return {
    width: sof.width,
    height: sof.height,
    progressive,
    maxH: sof.maxH,
    maxV: sof.maxV,
    mcuCols: sof.mcuCols,
    mcuRows: sof.mcuRows,
    components,
  };
}

/** Coeff store is one Int16 per sample; allocate only once a scan exists. */
function ensureCoeffBuffers(frame: Frame): void {
  for (const c of frame.components) {
    if (c.coeffs.length === 0) {
      c.coeffs = new Int16Array(c.blocksW * c.blocksH * 64);
    }
  }
}

function parseAdobeTransform(payload: Uint8Array): number | undefined {
  if (payload.length < 12) {
    return undefined;
  }
  if (
    u8(payload, 0) !== 0x41 ||
    u8(payload, 1) !== 0x64 ||
    u8(payload, 2) !== 0x6f ||
    u8(payload, 3) !== 0x62 ||
    u8(payload, 4) !== 0x65
  ) {
    return undefined;
  }
  return u8(payload, 11);
}

type ScanKind = {
  baseline: boolean;
  dc: "first" | "refine" | false;
  ac: "first" | "refine" | false;
};

function scanKind(progressive: boolean, ss: number, se: number, ah: number, al: number): ScanKind {
  if (!progressive) {
    if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) {
      throw jpegError("progressive spectral selection is not supported");
    }
    return { baseline: true, dc: false, ac: false };
  }
  if (ss < 0 || se < ss || se > 63 || al > 13 || ah > 13) {
    throw jpegError("invalid spectral selection");
  }
  const dc: ScanKind["dc"] = ss === 0 ? (ah === 0 ? "first" : "refine") : false;
  const ac: ScanKind["ac"] = se > 0 ? (ah === 0 ? "first" : "refine") : false;
  if (!dc && !ac) {
    throw jpegError("invalid spectral selection");
  }
  return { baseline: false, dc, ac };
}

function decodeScan(
  data: Uint8Array,
  sosOffset: number,
  frame: Frame,
  dcTables: Array<HuffmanDecode | undefined>,
  acTables: Array<HuffmanDecode | undefined>,
  restartInterval: number,
): number {
  ensureCoeffBuffers(frame);
  const length = readUint16(data, sosOffset);
  if (length < 6 || sosOffset + length > data.length) {
    throw jpegError("truncated SOS");
  }
  const payload = data.subarray(sosOffset + 2, sosOffset + length);
  const nScan = u8(payload, 0);
  if (nScan < 1 || nScan > frame.components.length) {
    throw jpegError("invalid SOS component count");
  }
  let p = 1;
  const scanComps: Component[] = [];
  for (let i = 0; i < nScan; i++) {
    const id = u8(payload, p);
    const tables = u8(payload, p + 1);
    p += 2;
    const comp = frame.components.find((c) => c.id === id);
    if (comp === undefined) {
      throw jpegError("SOS component id is not in SOF");
    }
    comp.dcTable = tables >> 4;
    comp.acTable = tables & 0x0f;
    scanComps.push(comp);
  }
  const ss = u8(payload, p);
  const se = u8(payload, p + 1);
  const ahAl = u8(payload, p + 2);
  const ah = ahAl >> 4;
  const al = ahAl & 0x0f;
  const kind = scanKind(frame.progressive, ss, se, ah, al);

  const bits = new BitReader(data, sosOffset + length);
  const zz = new Int32Array(64);
  const prog: ProgressiveScan = { ss, se, ah, al, eobrun: 0, acState: 0, acNext: 0 };
  const interleaved = nScan > 1;
  const totalMcus = interleaved
    ? frame.mcuCols * frame.mcuRows
    : (() => {
        const c0 = scanComps[0];
        if (c0 === undefined) {
          throw jpegError("invalid SOS component count");
        }
        return c0.scanBlocksW * c0.scanBlocksH;
      })();

  let mcu = 0;
  while (mcu < totalMcus) {
    const interval =
      restartInterval > 0 ? Math.min(totalMcus - mcu, restartInterval) : totalMcus - mcu;
    for (const c of frame.components) {
      c.pred = 0;
    }
    resetProgressiveScan(prog);

    const intervalEnd = mcu + interval;
    for (let n = 0; n < interval; n++) {
      if (bits.exhausted) {
        // Entropy data ran out (hit a marker): the rest of this interval keeps
        // whatever earlier scans stored, like libjpeg. Without a restart marker
        // to resume at, the scan is over — a data-less scan must not cost a
        // full pass over the image.
        if (restartInterval > 0 && bits.atRestart && intervalEnd < totalMcus) {
          mcu = intervalEnd;
          break;
        }
        return bits.offset;
      }
      if (interleaved) {
        const mx = mcu % frame.mcuCols;
        const my = Math.floor(mcu / frame.mcuCols);
        for (const comp of scanComps) {
          for (let v = 0; v < comp.v; v++) {
            for (let h = 0; h < comp.h; h++) {
              decodeDataUnit(
                bits,
                comp,
                mx * comp.h + h,
                my * comp.v + v,
                kind,
                dcTables,
                acTables,
                zz,
                prog,
              );
            }
          }
        }
      } else {
        const comp = scanComps[0];
        if (comp === undefined) {
          throw jpegError("invalid SOS component count");
        }
        const bx = mcu % comp.scanBlocksW;
        const by = Math.floor(mcu / comp.scanBlocksW);
        decodeDataUnit(bits, comp, bx, by, kind, dcTables, acTables, zz, prog);
      }
      mcu += 1;
    }

    if (mcu < totalMcus) {
      if (bits.exhausted && !bits.atRestart) {
        return bits.offset;
      }
      bits.consumeRestart();
    }
  }

  return bits.offset;
}

function decodeDataUnit(
  bits: BitReader,
  comp: Component,
  bx: number,
  by: number,
  kind: ScanKind,
  dcTables: Array<HuffmanDecode | undefined>,
  acTables: Array<HuffmanDecode | undefined>,
  zz: Int32Array,
  prog: ProgressiveScan,
): void {
  if (kind.baseline) {
    const dcTab = dcTables[comp.dcTable];
    const acTab = acTables[comp.acTable];
    if (dcTab === undefined || acTab === undefined) {
      throw jpegError("missing a Huffman table");
    }
    zz.fill(0);
    const dc = decodeDc(bits, dcTab, comp.pred);
    comp.pred = dc;
    zz[0] = dc;
    decodeAc(bits, acTab, zz);
    const dest = coeffBlock(comp, bx, by);
    for (let i = 0; i < 64; i++) {
      dest[i] = zz[i] ?? 0;
    }
    return;
  }

  const coeffs = coeffBlock(comp, bx, by);
  if (kind.dc === "first") {
    const dcTab = dcTables[comp.dcTable];
    if (dcTab === undefined) {
      throw jpegError("missing a Huffman table");
    }
    comp.pred = decodeDcFirst(bits, dcTab, coeffs, comp.pred, prog.al);
  } else if (kind.dc === "refine") {
    decodeDcRefine(bits, coeffs, prog.al);
  }
  if (kind.ac) {
    const acTab = acTables[comp.acTable];
    if (acTab === undefined) {
      throw jpegError("missing a Huffman table");
    }
    if (kind.ac === "first") {
      decodeAcFirst(bits, acTab, coeffs, prog);
    } else {
      decodeAcRefine(bits, acTab, coeffs, prog);
    }
  }
}

function idctComponents(
  components: readonly JpegCoeffComponent[],
  qTables: ReadonlyArray<JpegQuantTable | undefined>,
): PlaneComponent[] {
  const scratch = new Float64Array(64);
  const planes: PlaneComponent[] = [];
  for (const comp of components) {
    const quant = qTables[comp.qTable];
    if (quant === undefined) {
      throw jpegError("missing a quantization table");
    }
    const planeW = comp.blocksW * 8;
    const planeH = comp.blocksH * 8;
    const plane = new Uint8Array(planeW * planeH);
    for (let by = 0; by < comp.blocksH; by++) {
      for (let bx = 0; bx < comp.blocksW; bx++) {
        const i = (by * comp.blocksW + bx) * 64;
        dequantIdct(comp.coeffs.subarray(i, i + 64), quant.values, scratch);
        blitU8(plane, planeW, bx, by, scratch);
      }
    }
    planes.push({ ...comp, planeW, planeH, plane });
  }
  return planes;
}

function findComponent(
  components: readonly PlaneComponent[],
  id: number,
): PlaneComponent | undefined {
  for (const c of components) {
    if (c.id === id) {
      return c;
    }
  }
  return undefined;
}

function upsampleCompRow(
  comp: PlaneComponent,
  maxH: number,
  maxV: number,
  width: number,
  height: number,
  outY: number,
  dst: Uint8Array,
  fancy: boolean,
): void {
  upsampleComponentRow(
    comp.plane,
    comp.planeW,
    comp.planeH,
    comp.h,
    comp.v,
    maxH,
    maxV,
    width,
    height,
    outY,
    dst,
    fancy,
  );
}

function toRgba(
  width: number,
  height: number,
  components: readonly PlaneComponent[],
  adobeTransform: number | undefined,
  fancy: boolean,
): PixelBuffer {
  const data = new Uint8Array(width * height * 4);
  const n = components.length;
  const row0 = new Uint8Array(width);
  const row1 = new Uint8Array(width);
  const row2 = new Uint8Array(width);
  const row3 = new Uint8Array(width);

  let maxH = 1;
  let maxV = 1;
  for (const c of components) {
    if (c.h > maxH) {
      maxH = c.h;
    }
    if (c.v > maxV) {
      maxV = c.v;
    }
  }

  if (n === 1) {
    const yComp = components[0];
    if (yComp === undefined) {
      throw jpegError("missing a scan");
    }
    for (let y = 0; y < height; y++) {
      upsampleCompRow(yComp, yComp.h, yComp.v, width, height, y, row0, fancy);
      let o = y * width * 4;
      for (let x = 0; x < width; x++) {
        const gy = row0[x] ?? 0;
        data[o] = gy;
        data[o + 1] = gy;
        data[o + 2] = gy;
        data[o + 3] = 255;
        o += 4;
      }
    }
    return { width, height, data };
  }

  const c0 = components[0];
  const c1 = components[1];
  const c2 = components[2];
  if (c0 === undefined || c1 === undefined || c2 === undefined) {
    throw jpegError("missing color components");
  }

  if (n === 4) {
    const c3 = components[3];
    if (c3 === undefined) {
      throw jpegError("missing color components");
    }
    const ycck = adobeTransform === 2;
    for (let y = 0; y < height; y++) {
      upsampleCompRow(c0, maxH, maxV, width, height, y, row0, fancy);
      upsampleCompRow(c1, maxH, maxV, width, height, y, row1, fancy);
      upsampleCompRow(c2, maxH, maxV, width, height, y, row2, fancy);
      upsampleCompRow(c3, maxH, maxV, width, height, y, row3, fancy);
      let o = y * width * 4;
      for (let x = 0; x < width; x++) {
        const a = row0[x] ?? 0;
        const b = row1[x] ?? 0;
        const c = row2[x] ?? 0;
        const k = row3[x] ?? 0;
        if (ycck) {
          const rgb = ycbcrToRgb(a, b, c);
          data[o] = clamp8((rgb.r * k) / 255);
          data[o + 1] = clamp8((rgb.g * k) / 255);
          data[o + 2] = clamp8((rgb.b * k) / 255);
        } else {
          data[o] = clamp8((a * k) / 255);
          data[o + 1] = clamp8((b * k) / 255);
          data[o + 2] = clamp8((c * k) / 255);
        }
        data[o + 3] = 255;
        o += 4;
      }
    }
    return { width, height, data };
  }

  if (adobeTransform === 0) {
    for (let y = 0; y < height; y++) {
      upsampleCompRow(c0, maxH, maxV, width, height, y, row0, fancy);
      upsampleCompRow(c1, maxH, maxV, width, height, y, row1, fancy);
      upsampleCompRow(c2, maxH, maxV, width, height, y, row2, fancy);
      let o = y * width * 4;
      for (let x = 0; x < width; x++) {
        data[o] = row0[x] ?? 0;
        data[o + 1] = row1[x] ?? 0;
        data[o + 2] = row2[x] ?? 0;
        data[o + 3] = 255;
        o += 4;
      }
    }
    return { width, height, data };
  }

  const yComp = findComponent(components, 1) ?? c0;
  const cbComp = findComponent(components, 2) ?? c1;
  const crComp = findComponent(components, 3) ?? c2;
  for (let y = 0; y < height; y++) {
    upsampleCompRow(yComp, maxH, maxV, width, height, y, row0, fancy);
    upsampleCompRow(cbComp, maxH, maxV, width, height, y, row1, fancy);
    upsampleCompRow(crComp, maxH, maxV, width, height, y, row2, fancy);
    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const rgb = ycbcrToRgb(row0[x] ?? 0, row1[x] ?? 0, row2[x] ?? 0);
      data[o] = rgb.r;
      data[o + 1] = rgb.g;
      data[o + 2] = rgb.b;
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { width, height, data };
}

/**
 * Header + entropy decode to quantized zigzag coefficients. No dequant / IDCT /
 * color convert. Baseline and progressive inputs share this representation.
 */
export function decodeJpegCoefficients(bytes: Uint8Array, maxPixels?: number): JpegCoefficients {
  if (bytes.length < 2) {
    throw jpegError("empty input");
  }
  if (u8(bytes, 0) !== 0xff || u8(bytes, 1) !== 0xd8) {
    throw jpegError("invalid signature");
  }

  let pos = 2;
  const qTables: Array<JpegQuantTable | undefined> = [];
  const dcTables: Array<HuffmanDecode | undefined> = [];
  const acTables: Array<HuffmanDecode | undefined> = [];
  let frame: Frame | undefined;
  let restartInterval = 0;
  let adobeTransform: number | undefined;
  let adobeBytes: Uint8Array | undefined;
  let orientation = 1;
  let decoded = false;
  let scans = 0;

  while (pos < bytes.length) {
    if (u8(bytes, pos) !== 0xff) {
      throw jpegError("expected marker");
    }
    pos = skipFill(bytes, pos);
    if (pos >= bytes.length) {
      break;
    }
    const marker = u8(bytes, pos);
    pos += 1;

    if (marker === 0xd9) {
      break;
    }
    if (marker === 0x00 || marker === 0xff) {
      throw jpegError("invalid marker");
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }

    if (marker === 0xda) {
      if (frame === undefined) {
        throw jpegError("SOS before SOF");
      }
      scans += 1;
      if (scans > MAX_SCANS) {
        throw jpegError(`more than ${MAX_SCANS} scans`);
      }
      pos = decodeScan(bytes, pos, frame, dcTables, acTables, restartInterval);
      decoded = true;
      continue;
    }

    const length = readUint16(bytes, pos);
    if (length < 2 || pos + length > bytes.length) {
      throw jpegError("truncated segment");
    }
    const payload = bytes.subarray(pos + 2, pos + length);
    pos += length;

    if (marker === 0xdb) {
      parseDqt(payload, qTables);
    } else if (marker === 0xc4) {
      parseDht(payload, dcTables, acTables);
    } else if (marker === 0xc0 || marker === 0xc2) {
      if (frame !== undefined) {
        throw jpegError("more than one frame");
      }
      frame = parseSof(payload, marker === 0xc2, maxPixels);
    } else if (marker !== 0xc4 && marker !== 0xc8 && marker >= 0xc1 && marker <= 0xcf) {
      const named = unsupportedSofMessage(marker);
      throw jpegError(named ?? `unsupported frame type 0xFF${marker.toString(16)}`);
    } else if (marker === 0xdd) {
      if (payload.length < 2) {
        throw jpegError("truncated DRI");
      }
      restartInterval = readUint16(payload, 0);
    } else if (marker === 0xe1) {
      const parsed = parseExifOrientation(payload);
      if (orientation === 1 && parsed !== 1) {
        orientation = parsed;
      }
    } else if (marker === 0xee) {
      const t = parseAdobeTransform(payload);
      if (t !== undefined) {
        adobeTransform = t;
        adobeBytes = payload;
      }
    }
  }

  if (!decoded || frame === undefined) {
    throw jpegError("missing a scan");
  }

  for (const c of frame.components) {
    if (qTables[c.qTable] === undefined) {
      throw jpegError("missing a quantization table");
    }
  }

  const components: JpegCoeffComponent[] = frame.components.map((c) => ({
    id: c.id,
    h: c.h,
    v: c.v,
    qTable: c.qTable,
    blocksW: c.blocksW,
    blocksH: c.blocksH,
    scanBlocksW: c.scanBlocksW,
    scanBlocksH: c.scanBlocksH,
    coeffs: c.coeffs,
  }));

  return {
    width: frame.width,
    height: frame.height,
    progressive: frame.progressive,
    maxH: frame.maxH,
    maxV: frame.maxV,
    mcuCols: frame.mcuCols,
    mcuRows: frame.mcuRows,
    components,
    quantTables: qTables,
    orientation,
    adobe: adobeTransform,
    adobeBytes,
  };
}

function validateDecodeOptions(options: JpegDecodeOptions | undefined): void {
  // Untyped JS callers can pass anything: check the runtime value, not the type.
  const upsample: unknown = options?.upsample;
  if (upsample !== undefined && upsample !== "fancy" && upsample !== "nearest") {
    throw jpegRangeError('upsample must be "fancy" or "nearest"');
  }
  const orientation: unknown = options?.orientation;
  if (orientation !== undefined && orientation !== "apply" && orientation !== "ignore") {
    throw jpegRangeError('orientation must be "apply" or "ignore"');
  }
}

/** JPEG decode: SOF0/SOF2 bytes in, packed RGBA out. Arithmetic / 12-bit throw. */
export function decodeJpeg(bytes: Uint8Array, options?: JpegDecodeOptions): PixelBuffer {
  validateDecodeOptions(options);
  const coeffs = decodeJpegCoefficients(bytes, options?.maxPixels);
  const planes = idctComponents(coeffs.components, coeffs.quantTables);
  const fancy = options?.upsample !== "nearest";
  const rgba = toRgba(coeffs.width, coeffs.height, planes, coeffs.adobe, fancy);
  const mode = options?.orientation ?? "apply";
  if (mode === "ignore" || coeffs.orientation === 1) {
    return rgba;
  }
  return applyOrientation(rgba, coeffs.orientation);
}
