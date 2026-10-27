/** Packed 8-bit RGBA. `encodePng` / `decodePng` use this; you can pass your own `{ width, height, data }`. */
export type PixelBuffer = {
  readonly width: number;
  readonly height: number;
  /** Packed 8-bit RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8Array;
};

/** Allocate a zeroed RGBA buffer. Optional — skip if you already have pixels. */
export function createPixelBuffer(width: number, height: number): PixelBuffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("width and height must be positive integers");
  }
  return { width, height, data: new Uint8Array(width * height * 4) };
}
