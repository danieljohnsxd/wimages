/**
 * Shared decode guardrails. Every decoder validates header-declared sizes
 * against `maxPixels` before allocating anything sized by them.
 */

/**
 * Default pixel budget: 50 MP (8192 × 6144), the largest still a current phone
 * camera produces. RGBA at this size is ~200 MB; a 128 MB isolate (Cloudflare
 * Workers) should pass `maxPixels: 16_000_000` or less.
 */
export const DEFAULT_MAX_PIXELS = 8192 * 6144;

export type DecodeLimits = {
  /**
   * Maximum number of pixels one call may materialize, counting every frame of
   * an animation (`width × height × frames`) and, for JPEG, the padded MCU grid.
   * Headers declaring more throw before any pixel memory is reserved.
   * Default 50,331,648 (50 MP).
   */
  readonly maxPixels?: number;
};

export function checkDimensions(
  format: string,
  width: number,
  height: number,
  maxPixels: number = DEFAULT_MAX_PIXELS,
  frames = 1,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${format}: invalid dimensions ${width}x${height}`);
  }
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) {
    throw new Error(`${format}: maxPixels must be a positive number`);
  }
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`${format}: invalid frame count ${frames}`);
  }
  const total = width * height * frames;
  if (total > maxPixels) {
    const what = frames === 1 ? `${width}x${height}` : `${frames} frames of ${width}x${height}`;
    throw new Error(
      `${format}: ${what} exceeds maxPixels (${total} > ${maxPixels}); raise maxPixels to allow it`,
    );
  }
}
