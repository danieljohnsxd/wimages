/**
 * Component upsampling into one output row.
 *
 * Fancy paths match libjpeg-turbo `jdsample.c` (triangle filter, ordered-dither
 * rounding). Other ratios replicate, as turbo does for non-h2v1/h2v2/h1v2.
 */

/** Copy a full-size component row. `outW` is the image width, not MCU padding. */
function copyFullRow(
  plane: Uint8Array,
  planeW: number,
  planeH: number,
  outY: number,
  dst: Uint8Array,
  outW: number,
): void {
  const sy = outY < planeH ? outY : planeH - 1;
  dst.set(plane.subarray(sy * planeW, sy * planeW + outW));
}

function nearestRow(
  plane: Uint8Array,
  planeW: number,
  planeH: number,
  sampH: number,
  sampV: number,
  maxH: number,
  maxV: number,
  outY: number,
  dst: Uint8Array,
  outW: number,
): void {
  const sy = Math.min(planeH - 1, Math.floor((outY * sampV) / maxV));
  const row = sy * planeW;
  if (sampH === maxH) {
    for (let x = 0; x < outW; x++) {
      dst[x] = plane[row + Math.min(planeW - 1, x)] ?? 0;
    }
    return;
  }
  for (let x = 0; x < outW; x++) {
    const sx = Math.min(planeW - 1, Math.floor((x * sampH) / maxH));
    dst[x] = plane[row + sx] ?? 0;
  }
}

/** h2v1 fancy: 3/4 nearer + 1/4 further, +1/+2 rounding alternation. */
function fancyH2V1(
  plane: Uint8Array,
  planeW: number,
  srcW: number,
  srcH: number,
  outY: number,
  dst: Uint8Array,
  outW: number,
): void {
  const sy = outY < srcH ? outY : srcH - 1;
  const off = sy * planeW;
  const s0 = plane[off] ?? 0;
  const s1 = plane[off + 1] ?? 0;
  dst[0] = s0;
  dst[1] = (s0 * 3 + s1 + 2) >> 2;

  let di = 2;
  const lastI = srcW - 1;
  for (let i = 1; i < lastI; i++) {
    const sv = (plane[off + i] ?? 0) * 3;
    dst[di] = (sv + (plane[off + i - 1] ?? 0) + 1) >> 2;
    dst[di + 1] = (sv + (plane[off + i + 1] ?? 0) + 2) >> 2;
    di += 2;
  }

  const last = plane[off + lastI] ?? 0;
  dst[di] = (last * 3 + (plane[off + lastI - 1] ?? 0) + 1) >> 2;
  if (di + 1 < outW) {
    dst[di + 1] = last;
  }
}

function clampRow(y: number, srcH: number): number {
  if (y < 0) {
    return 0;
  }
  if (y >= srcH) {
    return srcH - 1;
  }
  return y;
}

function fancyNeighborRow(
  outY: number,
  srcH: number,
): { nearest: number; other: number; lower: boolean } {
  const inrow = outY >> 1;
  const lower = (outY & 1) !== 0;
  const nearest = clampRow(inrow, srcH);
  const other = clampRow(lower ? nearest + 1 : nearest - 1, srcH);
  return { nearest, other, lower };
}

/** h1v2 fancy: vertical 3/4 nearer + 1/4 further, bias 1 (above) / 2 (below). */
function fancyH1V2(
  plane: Uint8Array,
  planeW: number,
  srcW: number,
  srcH: number,
  outY: number,
  dst: Uint8Array,
  outW: number,
): void {
  const { nearest, other, lower } = fancyNeighborRow(outY, srcH);
  const bias = lower ? 2 : 1;
  const off0 = nearest * planeW;
  const off1 = other * planeW;
  const n = outW < srcW ? outW : srcW;
  for (let x = 0; x < n; x++) {
    dst[x] = ((plane[off0 + x] ?? 0) * 3 + (plane[off1 + x] ?? 0) + bias) >> 2;
  }
}

/**
 * h2v2 fancy: vertical mix into colsums, then the same horizontal 3/4+1/4.
 * Even columns `(3*this + last + 8) >> 4`, odd `(3*this + next + 7) >> 4`.
 */
function fancyH2V2(
  plane: Uint8Array,
  planeW: number,
  srcW: number,
  srcH: number,
  outY: number,
  dst: Uint8Array,
  outW: number,
): void {
  const { nearest, other } = fancyNeighborRow(outY, srcH);
  const off0 = nearest * planeW;
  const off1 = other * planeW;

  let cur = (plane[off0] ?? 0) * 3 + (plane[off1] ?? 0);
  let next = (plane[off0 + 1] ?? 0) * 3 + (plane[off1 + 1] ?? 0);
  dst[0] = (cur * 4 + 8) >> 4;
  dst[1] = (cur * 3 + next + 7) >> 4;
  let last = cur;
  cur = next;

  let di = 2;
  for (let i = 2; i < srcW; i++) {
    next = (plane[off0 + i] ?? 0) * 3 + (plane[off1 + i] ?? 0);
    dst[di] = (cur * 3 + last + 8) >> 4;
    dst[di + 1] = (cur * 3 + next + 7) >> 4;
    last = cur;
    cur = next;
    di += 2;
  }

  dst[di] = (cur * 3 + last + 8) >> 4;
  if (di + 1 < outW) {
    dst[di + 1] = (cur * 4 + 7) >> 4;
  }
}

/** Upsample one component into `dst` (length `outW`) for output row `outY`. */
export function upsampleComponentRow(
  plane: Uint8Array,
  planeW: number,
  planeH: number,
  sampH: number,
  sampV: number,
  maxH: number,
  maxV: number,
  outW: number,
  outH: number,
  outY: number,
  dst: Uint8Array,
  fancy: boolean,
): void {
  if (sampH === maxH && sampV === maxV) {
    copyFullRow(plane, planeW, planeH, outY, dst, outW);
    return;
  }

  const srcW = Math.min(planeW, Math.ceil((outW * sampH) / maxH));
  const srcH = Math.min(planeH, Math.ceil((outH * sampV) / maxV));
  const h2 = sampH * 2 === maxH;
  const v2 = sampV * 2 === maxV;
  const h1 = sampH === maxH;
  const v1 = sampV === maxV;

  if (fancy && h2 && v1 && srcW > 2) {
    fancyH2V1(plane, planeW, srcW, srcH, outY, dst, outW);
    return;
  }
  if (fancy && h2 && v2 && srcW > 2) {
    fancyH2V2(plane, planeW, srcW, srcH, outY, dst, outW);
    return;
  }
  if (fancy && h1 && v2) {
    fancyH1V2(plane, planeW, srcW, srcH, outY, dst, outW);
    return;
  }

  nearestRow(plane, planeW, planeH, sampH, sampV, maxH, maxV, outY, dst, outW);
}
