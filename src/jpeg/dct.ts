/**
 * 8×8 JPEG DCT (T.81 A.3.3), float separable form.
 *
 * Input/output are natural (row-major) order. Samples are already level-shifted
 * (−128) for FDCT; IDCT yields level-shifted samples. Not integer AAN/LLM —
 * invertibility of the pair matters more than the fast integer network.
 */

const COS = makeCos();
const ALPHA = new Float64Array([1 / Math.SQRT2, 1, 1, 1, 1, 1, 1, 1]);
const TMP = new Float64Array(64);

function makeCos(): Float64Array {
  const c = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      c[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return c;
}

function at(a: Float64Array, i: number): number {
  return a[i] ?? 0;
}

/** In-place forward DCT. `block` is 64 level-shifted samples. */
export function fdct8(block: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    const row = y * 8;
    for (let u = 0; u < 8; u++) {
      let s = 0;
      const base = u * 8;
      for (let x = 0; x < 8; x++) {
        s += at(block, row + x) * at(COS, base + x);
      }
      TMP[row + u] = 0.5 * at(ALPHA, u) * s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      const base = v * 8;
      for (let y = 0; y < 8; y++) {
        s += at(TMP, y * 8 + u) * at(COS, base + y);
      }
      block[v * 8 + u] = 0.5 * at(ALPHA, v) * s;
    }
  }
}

/** In-place inverse DCT. `block` is 64 spatial-frequency coefficients. */
export function idct8(block: Float64Array): void {
  for (let v = 0; v < 8; v++) {
    const row = v * 8;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) {
        s += at(ALPHA, u) * at(block, row + u) * at(COS, u * 8 + x);
      }
      TMP[row + x] = 0.5 * s;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) {
        s += at(ALPHA, v) * at(TMP, v * 8 + x) * at(COS, v * 8 + y);
      }
      block[y * 8 + x] = 0.5 * s;
    }
  }
}
