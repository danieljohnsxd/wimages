import { checkDimensions } from "../limits.ts";
import { jpegError } from "./error.ts";

export type JpegSamp = {
  readonly h: number;
  readonly v: number;
};

export type JpegBlockGrid = {
  readonly blocksW: number;
  readonly blocksH: number;
  readonly scanBlocksW: number;
  readonly scanBlocksH: number;
};

export type JpegSofComponent = JpegSamp & {
  readonly id: number;
  readonly qTable: number;
  readonly blocksW: number;
  readonly blocksH: number;
  readonly scanBlocksW: number;
  readonly scanBlocksH: number;
};

export type JpegSofHeader = {
  readonly precision: number;
  readonly width: number;
  readonly height: number;
  readonly maxH: number;
  readonly maxV: number;
  readonly mcuCols: number;
  readonly mcuRows: number;
  readonly paddedW: number;
  readonly paddedH: number;
  readonly components: readonly JpegSofComponent[];
  readonly planeSamples: number;
};

function u8(data: Uint8Array, i: number): number {
  const v = data[i];
  if (v === undefined) {
    throw jpegError("truncated SOF");
  }
  return v;
}

function u16(data: Uint8Array, i: number): number {
  return (u8(data, i) << 8) | u8(data, i + 1);
}

/** MCU-padded output size: ceil to sampling-factor multiples of 8. */
export function jpegMcuGrid(
  width: number,
  height: number,
  maxH: number,
  maxV: number,
): {
  readonly mcuCols: number;
  readonly mcuRows: number;
  readonly paddedW: number;
  readonly paddedH: number;
} {
  const mcuCols = Math.ceil(width / (8 * maxH));
  const mcuRows = Math.ceil(height / (8 * maxV));
  return {
    mcuCols,
    mcuRows,
    paddedW: mcuCols * 8 * maxH,
    paddedH: mcuRows * 8 * maxV,
  };
}

export function jpegBlockGrid(
  width: number,
  height: number,
  h: number,
  v: number,
  maxH: number,
  maxV: number,
): JpegBlockGrid {
  const { mcuCols, mcuRows } = jpegMcuGrid(width, height, maxH, maxV);
  const scanBlocksW = Math.ceil(Math.ceil((width * h) / maxH) / 8);
  const scanBlocksH = Math.ceil(Math.ceil((height * v) / maxV) / 8);
  return {
    blocksW: Math.max(mcuCols * h, scanBlocksW),
    blocksH: Math.max(mcuRows * v, scanBlocksH),
    scanBlocksW,
    scanBlocksH,
  };
}

/**
 * Parse SOF0/SOF2 payload (no allocation). Sampling 1–4, 1/3/4 components.
 * Precision is returned as-is; the caller names 12-bit / other depths.
 */
export function parseSofHeader(payload: Uint8Array): JpegSofHeader {
  if (payload.length < 6) {
    throw jpegError("truncated SOF");
  }
  const precision = u8(payload, 0);
  const height = u16(payload, 1);
  const width = u16(payload, 3);
  const n = u8(payload, 5);
  if (n !== 1 && n !== 3 && n !== 4) {
    throw jpegError(`unsupported component count ${n}`);
  }
  if (payload.length < 6 + n * 3) {
    throw jpegError("truncated SOF");
  }

  let maxH = 1;
  let maxV = 1;
  const raw: Array<{ id: number; h: number; v: number; qTable: number }> = [];
  for (let c = 0; c < n; c++) {
    const o = 6 + c * 3;
    const id = u8(payload, o);
    const hv = u8(payload, o + 1);
    const h = hv >> 4;
    const v = hv & 0x0f;
    const qTable = u8(payload, o + 2);
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      throw jpegError("invalid sampling factor");
    }
    if (h > maxH) {
      maxH = h;
    }
    if (v > maxV) {
      maxV = v;
    }
    raw.push({ id, h, v, qTable });
  }

  const grid = jpegMcuGrid(width, height, maxH, maxV);
  const components: JpegSofComponent[] = [];
  let planeSamples = 0;
  for (const c of raw) {
    const blocks = jpegBlockGrid(width, height, c.h, c.v, maxH, maxV);
    planeSamples += blocks.blocksW * blocks.blocksH * 64;
    components.push({ ...c, ...blocks });
  }

  return {
    precision,
    width,
    height,
    maxH,
    maxV,
    mcuCols: grid.mcuCols,
    mcuRows: grid.mcuRows,
    paddedW: grid.paddedW,
    paddedH: grid.paddedH,
    components,
    planeSamples,
  };
}

/**
 * Reject before allocating. `maxPixels` counts image pixels (width × height),
 * the same unit as every other decoder, so a 50 MP 4:2:0 phone photo fits the
 * 50 MP default.
 *
 * Sample memory needs no second budget: every component plane is at most the
 * MCU-padded grid, which adds < 32 px per side, so the coefficient store is
 * bounded by components (≤ 4) × (width + 31) × (height + 31) Int16s — at most
 * 4× the RGBA output plus a fixed edge term, before any scan is read.
 */
export function checkJpegBudget(sof: JpegSofHeader, maxPixels?: number): void {
  checkDimensions("JPEG", sof.width, sof.height, maxPixels);
}

/** SOF markers we refuse, named the way the README promises. */
export function unsupportedSofMessage(marker: number): string | undefined {
  switch (marker) {
    case 0xc1:
      return "extended sequential (SOF1) is not supported";
    case 0xc3:
      return "lossless (SOF3) is not supported";
    case 0xc5:
      return "hierarchical (SOF5) is not supported";
    case 0xc6:
      return "hierarchical (SOF6) is not supported";
    case 0xc7:
      return "hierarchical (SOF7) is not supported";
    case 0xc9:
      return "arithmetic coding (SOF9) is not supported";
    case 0xca:
      return "arithmetic coding (SOF10) is not supported";
    case 0xcb:
      return "arithmetic coding (SOF11) is not supported";
    case 0xcd:
      return "hierarchical (SOF13) is not supported";
    case 0xce:
      return "hierarchical (SOF14) is not supported";
    case 0xcf:
      return "hierarchical (SOF15) is not supported";
    default:
      return undefined;
  }
}

export function precisionMessage(precision: number): string {
  if (precision === 12) {
    return "12-bit precision is not supported";
  }
  return `${precision}-bit precision is not supported`;
}
