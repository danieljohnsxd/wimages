import type { ImageMetadata } from "../metadata.ts";
import type { PixelBuffer } from "../pixels.ts";
import { ByteWriter } from "./bits.ts";
import { compositeOnBackground, downsample420Mcu, downsample422Mcu, rgbToYcbcr } from "./color.ts";
import { fdct8 } from "./dct.ts";
import { jpegRangeError } from "./error.ts";
import { writeApp0, writeDqt, writeMarker, writeSof } from "./markers.ts";
import { writeJpegMetadata } from "./metadata.ts";
import { encodeProgressiveScans, encodeSequentialScans, type ComponentCoeffs } from "./scan.ts";
import { scaleQuantTable, STD_CHR_QUANT, STD_LUM_QUANT, ZIGZAG } from "./tables.ts";

export type JpegEncodeOptions = {
  /**
   * "small" = q65 4:2:0, "balanced" (default) = q80 4:2:0, "high" = q90 4:4:4.
   * A number is the IJG 1–100 scale (interop escape hatch); chroma then defaults to 4:2:0.
   */
  readonly quality?: "small" | "balanced" | "high" | number;
  /** Overrides the preset's chroma. */
  readonly chroma?: "4:2:0" | "4:2:2" | "4:4:4";
  /** SOF2 + libjpeg-turbo YCbCr scan script. Default false. */
  readonly progressive?: boolean;
  /** RGB background for alpha compositing. Default white `[255, 255, 255]`. */
  readonly background?: readonly [number, number, number];
  /** EXIF / XMP / ICC written after APP0. Default none. */
  readonly metadata?: ImageMetadata;
};

const CHROMA = new Set<NonNullable<JpegEncodeOptions["chroma"]>>(["4:2:0", "4:2:2", "4:4:4"]);

const QUALITY_PRESETS = {
  small: { quality: 65, chroma: "4:2:0" },
  balanced: { quality: 80, chroma: "4:2:0" },
  high: { quality: 90, chroma: "4:4:4" },
} as const;

function resolveQuality(quality: JpegEncodeOptions["quality"]): {
  readonly quality: number;
  readonly chroma: NonNullable<JpegEncodeOptions["chroma"]>;
} {
  if (quality === undefined) {
    return QUALITY_PRESETS.balanced;
  }
  if (quality === "small" || quality === "balanced" || quality === "high") {
    return QUALITY_PRESETS[quality];
  }
  if (typeof quality === "number" && Number.isInteger(quality) && quality >= 1 && quality <= 100) {
    return { quality, chroma: "4:2:0" };
  }
  throw jpegRangeError('quality must be "small", "balanced", "high", or an integer from 1 to 100');
}

type Layout = {
  readonly chroma: NonNullable<JpegEncodeOptions["chroma"]>;
  readonly mcuW: number;
  readonly mcuH: number;
  readonly yH: number;
  readonly yV: number;
};

function chromaLayout(chroma: NonNullable<JpegEncodeOptions["chroma"]>): Layout {
  if (chroma === "4:2:0") {
    return { chroma, mcuW: 16, mcuH: 16, yH: 2, yV: 2 };
  }
  if (chroma === "4:2:2") {
    return { chroma, mcuW: 16, mcuH: 8, yH: 2, yV: 1 };
  }
  return { chroma, mcuW: 8, mcuH: 8, yH: 1, yV: 1 };
}

/** T.81 A.2.2: non-interleaved block grid is ceil(ceil(X·Hi/Hmax)/8) × ceil(ceil(Y·Vi/Vmax)/8). */
function scanBlocks(
  width: number,
  height: number,
  h: number,
  v: number,
  hMax: number,
  vMax: number,
): { readonly cols: number; readonly rows: number } {
  return {
    cols: Math.ceil(Math.ceil((width * h) / hMax) / 8),
    rows: Math.ceil(Math.ceil((height * v) / vMax) / 8),
  };
}

function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

function isByte(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;
}

function parseBackground(
  background: JpegEncodeOptions["background"],
): readonly [number, number, number] {
  if (background === undefined) {
    return [255, 255, 255];
  }
  // Untyped JS callers can pass any array: check the runtime shape, not the tuple type.
  const bg: readonly unknown[] = background;
  const r = bg[0];
  const g = bg[1];
  const b = bg[2];
  if (!isByte(r) || !isByte(g) || !isByte(b) || bg.length !== 3) {
    throw jpegRangeError("background must be three integers from 0 to 255");
  }
  return [r, g, b];
}

function copyBlock(
  plane: Float64Array,
  planeW: number,
  x: number,
  y: number,
  scratch: Float64Array,
): void {
  for (let row = 0; row < 8; row++) {
    const src = (y + row) * planeW + x;
    const dst = row * 8;
    for (let col = 0; col < 8; col++) {
      scratch[dst + col] = plane[src + col] ?? 0;
    }
  }
}

function quantizeZigzag(block: Float64Array, quant: Uint8Array, zz: Int32Array): void {
  for (let i = 0; i < 64; i++) {
    const n = ZIGZAG[i] ?? 0;
    const q = quant[n] ?? 1;
    zz[i] = roundHalfAway((block[n] ?? 0) / q);
  }
}

function storeBlock(zz: Int32Array, dest: Int16Array, off: number): void {
  for (let i = 0; i < 64; i++) {
    dest[off + i] = zz[i] ?? 0;
  }
}

function fillMcuSamples(
  image: PixelBuffer,
  mx: number,
  my: number,
  layout: Layout,
  bg: readonly [number, number, number],
  yPlane: Float64Array,
  cbPlane: Float64Array,
  crPlane: Float64Array,
): void {
  const { width, height, data } = image;
  const x0 = mx * layout.mcuW;
  const y0 = my * layout.mcuH;
  const [bgR, bgG, bgB] = bg;
  for (let row = 0; row < layout.mcuH; row++) {
    let sy = y0 + row;
    if (sy >= height) {
      sy = height - 1;
    }
    for (let col = 0; col < layout.mcuW; col++) {
      let sx = x0 + col;
      if (sx >= width) {
        sx = width - 1;
      }
      const i = (sy * width + sx) * 4;
      const r0 = data[i] ?? 0;
      const g0 = data[i + 1] ?? 0;
      const b0 = data[i + 2] ?? 0;
      const a = data[i + 3] ?? 255;
      const r = compositeOnBackground(r0, a, bgR);
      const g = compositeOnBackground(g0, a, bgG);
      const b = compositeOnBackground(b0, a, bgB);
      const c = rgbToYcbcr(r, g, b);
      const o = row * layout.mcuW + col;
      yPlane[o] = c.y - 128;
      cbPlane[o] = c.cb - 128;
      crPlane[o] = c.cr - 128;
    }
  }
}

type BlockVisitor = {
  y: (bx: number, by: number, zz: Int32Array) => void;
  cb: (bx: number, by: number, zz: Int32Array) => void;
  cr: (bx: number, by: number, zz: Int32Array) => void;
};

function transformMcus(
  image: PixelBuffer,
  layout: Layout,
  mcuCols: number,
  mcuRows: number,
  bg: readonly [number, number, number],
  lumQ: Uint8Array,
  chrQ: Uint8Array,
  visit: BlockVisitor,
): void {
  const yPlane = new Float64Array(16 * 16);
  const cbPlane = new Float64Array(16 * 16);
  const crPlane = new Float64Array(16 * 16);
  const cb8 = new Float64Array(64);
  const cr8 = new Float64Array(64);
  const scratch = new Float64Array(64);
  const zz = new Int32Array(64);

  for (let my = 0; my < mcuRows; my++) {
    for (let mx = 0; mx < mcuCols; mx++) {
      fillMcuSamples(image, mx, my, layout, bg, yPlane, cbPlane, crPlane);
      for (let vy = 0; vy < layout.yV; vy++) {
        for (let hx = 0; hx < layout.yH; hx++) {
          copyBlock(yPlane, layout.mcuW, hx * 8, vy * 8, scratch);
          fdct8(scratch);
          quantizeZigzag(scratch, lumQ, zz);
          visit.y(mx * layout.yH + hx, my * layout.yV + vy, zz);
        }
      }
      if (layout.chroma === "4:2:0") {
        downsample420Mcu(cbPlane, layout.mcuW, cb8);
        downsample420Mcu(crPlane, layout.mcuW, cr8);
        fdct8(cb8);
        quantizeZigzag(cb8, chrQ, zz);
        visit.cb(mx, my, zz);
        fdct8(cr8);
        quantizeZigzag(cr8, chrQ, zz);
        visit.cr(mx, my, zz);
      } else if (layout.chroma === "4:2:2") {
        downsample422Mcu(cbPlane, layout.mcuW, cb8);
        downsample422Mcu(crPlane, layout.mcuW, cr8);
        fdct8(cb8);
        quantizeZigzag(cb8, chrQ, zz);
        visit.cb(mx, my, zz);
        fdct8(cr8);
        quantizeZigzag(cr8, chrQ, zz);
        visit.cr(mx, my, zz);
      } else {
        copyBlock(cbPlane, layout.mcuW, 0, 0, scratch);
        fdct8(scratch);
        quantizeZigzag(scratch, chrQ, zz);
        visit.cb(mx, my, zz);
        copyBlock(crPlane, layout.mcuW, 0, 0, scratch);
        fdct8(scratch);
        quantizeZigzag(scratch, chrQ, zz);
        visit.cr(mx, my, zz);
      }
    }
  }
}

function validateEncodeOptions(options: JpegEncodeOptions | undefined): {
  readonly quality: number;
  readonly chroma: NonNullable<JpegEncodeOptions["chroma"]>;
  readonly progressive: boolean;
  readonly background: readonly [number, number, number];
} {
  // Untyped JS callers can pass anything: check the runtime value, not the type.
  const progressive: unknown = options?.progressive;
  if (progressive !== undefined && typeof progressive !== "boolean") {
    throw jpegRangeError("progressive must be a boolean");
  }
  const resolved = resolveQuality(options?.quality);
  const chroma = options?.chroma ?? resolved.chroma;
  if (!CHROMA.has(chroma)) {
    throw jpegRangeError('chroma must be "4:2:0", "4:2:2", or "4:4:4"');
  }
  return {
    quality: resolved.quality,
    chroma,
    progressive: progressive === true,
    background: parseBackground(options?.background),
  };
}

/** JPEG encode: RGBA pixels in, JPEG bytes out. Alpha is composited on `background` (white). */
export function encodeJpeg(image: PixelBuffer, options?: JpegEncodeOptions): Uint8Array {
  const { quality, chroma, progressive, background: bg } = validateEncodeOptions(options);
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw jpegRangeError("width and height must be positive integers");
  }
  if (width > 65535 || height > 65535) {
    throw jpegRangeError("width and height must be at most 65535");
  }
  if (data.length !== width * height * 4) {
    throw jpegRangeError("RGBA data length must equal width * height * 4");
  }

  const layout = chromaLayout(chroma);
  const mcuCols = Math.ceil(width / layout.mcuW);
  const mcuRows = Math.ceil(height / layout.mcuH);
  const yCols = mcuCols * layout.yH;
  const yRows = mcuRows * layout.yV;
  const cCols = mcuCols;
  const cRows = mcuRows;
  const lumQ = scaleQuantTable(STD_LUM_QUANT, quality);
  const chrQ = scaleQuantTable(STD_CHR_QUANT, quality);

  const out = new ByteWriter();
  writeMarker(out, 0xd8);
  writeApp0(out);
  writeJpegMetadata(out, options?.metadata);
  writeDqt(out, 0, lumQ);
  writeDqt(out, 1, chrQ);
  writeSof(out, progressive, width, height, [
    { id: 1, h: layout.yH, v: layout.yV, qTable: 0 },
    { id: 2, h: 1, v: 1, qTable: 1 },
    { id: 3, h: 1, v: 1, qTable: 1 },
  ]);

  const yCoeffs = new Int16Array(yCols * yRows * 64);
  const cbCoeffs = new Int16Array(cCols * cRows * 64);
  const crCoeffs = new Int16Array(cCols * cRows * 64);
  const storeOnly: BlockVisitor = {
    y(bx, by, zz) {
      storeBlock(zz, yCoeffs, (by * yCols + bx) * 64);
    },
    cb(bx, by, zz) {
      storeBlock(zz, cbCoeffs, (by * cCols + bx) * 64);
    },
    cr(bx, by, zz) {
      storeBlock(zz, crCoeffs, (by * cCols + bx) * 64);
    },
  };
  transformMcus(image, layout, mcuCols, mcuRows, bg, lumQ, chrQ, storeOnly);

  const hMax = layout.yH;
  const vMax = layout.yV;
  const yScan = scanBlocks(width, height, layout.yH, layout.yV, hMax, vMax);
  const cScan = scanBlocks(width, height, 1, 1, hMax, vMax);
  const comps: ComponentCoeffs[] = [
    {
      coeffs: yCoeffs,
      blockCols: yCols,
      scanCols: yScan.cols,
      scanRows: yScan.rows,
      h: layout.yH,
      v: layout.yV,
      id: 1,
      dcTbl: 0,
      acTbl: 0,
    },
    {
      coeffs: cbCoeffs,
      blockCols: cCols,
      scanCols: cScan.cols,
      scanRows: cScan.rows,
      h: 1,
      v: 1,
      id: 2,
      dcTbl: 1,
      acTbl: 1,
    },
    {
      coeffs: crCoeffs,
      blockCols: cCols,
      scanCols: cScan.cols,
      scanRows: cScan.rows,
      h: 1,
      v: 1,
      id: 3,
      dcTbl: 1,
      acTbl: 1,
    },
  ];
  if (progressive) {
    encodeProgressiveScans(out, comps, mcuCols, mcuRows);
  } else {
    encodeSequentialScans(out, comps, mcuCols, mcuRows);
  }
  writeMarker(out, 0xd9);
  return out.finish();
}
