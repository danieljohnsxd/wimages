/** Composite one 8-bit channel over an opaque background channel. */
export function compositeOnBackground(src: number, alpha: number, bg: number): number {
  return (src * alpha + bg * (255 - alpha)) / 255;
}

/** Composite one 8-bit channel over opaque white. */
export function compositeOnWhite(src: number, alpha: number): number {
  return compositeOnBackground(src, alpha, 255);
}

export type Ycbcr = {
  readonly y: number;
  readonly cb: number;
  readonly cr: number;
};

/** JFIF / BT.601 full-range RGB→YCbCr. Input channels are 0–255. */
export function rgbToYcbcr(r: number, g: number, b: number): Ycbcr {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b + 128,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b + 128,
  };
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

/** JFIF / BT.601 YCbCr→RGB. Outputs 0–255. */
export function ycbcrToRgb(
  y: number,
  cb: number,
  cr: number,
): { readonly r: number; readonly g: number; readonly b: number } {
  const cb0 = cb - 128;
  const cr0 = cr - 128;
  return {
    r: clamp8(y + 1.402 * cr0),
    g: clamp8(y - 0.344136 * cb0 - 0.714136 * cr0),
    b: clamp8(y + 1.772 * cb0),
  };
}

/** Box-filter 2×2 chroma downsample of a 16×16 MCU into an 8×8 block. */
export function downsample420Mcu(src: Float64Array, srcW: number, dst: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i00 = y * 2 * srcW + x * 2;
      const a = src[i00] ?? 0;
      const b = src[i00 + 1] ?? 0;
      const c = src[i00 + srcW] ?? 0;
      const d = src[i00 + srcW + 1] ?? 0;
      dst[y * 8 + x] = (a + b + c + d) * 0.25;
    }
  }
}

/** Horizontal 2:1 chroma downsample of a 16×8 MCU into an 8×8 block. */
export function downsample422Mcu(src: Float64Array, srcW: number, dst: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * srcW + x * 2;
      const a = src[i] ?? 0;
      const b = src[i + 1] ?? 0;
      dst[y * 8 + x] = (a + b) * 0.5;
    }
  }
}

/** Nearest-neighbor 2×2 chroma upsample. */
export function upsample420(src: Float64Array, srcW: number, srcH: number): Float64Array {
  const w = srcW * 2;
  const h = srcH * 2;
  const out = new Float64Array(w * h);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const s = src[y * srcW + x] ?? 0;
      const oy = y * 2;
      const ox = x * 2;
      out[oy * w + ox] = s;
      out[oy * w + ox + 1] = s;
      out[(oy + 1) * w + ox] = s;
      out[(oy + 1) * w + ox + 1] = s;
    }
  }
  return out;
}
