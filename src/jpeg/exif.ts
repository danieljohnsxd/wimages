import { exifOrientation } from "../metadata.ts";
import type { PixelBuffer } from "../pixels.ts";
import { jpegRangeError } from "./error.ts";

const EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] as const; // "Exif\0\0"

/**
 * APP1 payload: `Exif\0\0` + big-endian TIFF IFD0 with one SHORT tag 0x0112.
 * `orientation` must be 1–8.
 */
export function buildExifOrientationPayload(orientation: number): Uint8Array {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw jpegRangeError("EXIF orientation must be an integer from 1 to 8");
  }
  const payload = new Uint8Array(32);
  payload[0] = 0x45;
  payload[1] = 0x78;
  payload[2] = 0x69;
  payload[3] = 0x66;
  payload[4] = 0x00;
  payload[5] = 0x00;
  payload[6] = 0x4d;
  payload[7] = 0x4d;
  payload[8] = 0x00;
  payload[9] = 0x2a;
  payload[10] = 0x00;
  payload[11] = 0x00;
  payload[12] = 0x00;
  payload[13] = 0x08;
  payload[14] = 0x00;
  payload[15] = 0x01;
  payload[16] = 0x01;
  payload[17] = 0x12;
  payload[18] = 0x00;
  payload[19] = 0x03;
  payload[20] = 0x00;
  payload[21] = 0x00;
  payload[22] = 0x00;
  payload[23] = 0x01;
  payload[24] = 0x00;
  payload[25] = orientation;
  payload[26] = 0x00;
  payload[27] = 0x00;
  payload[28] = 0x00;
  payload[29] = 0x00;
  payload[30] = 0x00;
  payload[31] = 0x00;
  return payload;
}

/**
 * APP1 payload starting at "Exif\0\0". Returns 1–8, or 1 if missing/invalid.
 */
export function parseExifOrientation(app1: Uint8Array): number {
  if (app1.length < EXIF_MAGIC.length) {
    return 1;
  }
  for (let i = 0; i < EXIF_MAGIC.length; i++) {
    if (app1[i] !== EXIF_MAGIC[i]) {
      return 1;
    }
  }
  return exifOrientation(app1.subarray(EXIF_MAGIC.length));
}

function copyPixel(src: Uint8Array, so: number, dst: Uint8Array, d: number): void {
  dst[d] = src[so] ?? 0;
  dst[d + 1] = src[so + 1] ?? 0;
  dst[d + 2] = src[so + 2] ?? 0;
  dst[d + 3] = src[so + 3] ?? 255;
}

/** Map EXIF orientation 1–8 onto packed RGBA. Swaps width/height for 5–8. */
export function applyOrientation(image: PixelBuffer, orientation: number): PixelBuffer {
  if (orientation === 1) {
    return image;
  }
  const srcW = image.width;
  const srcH = image.height;
  const src = image.data;
  const swap = orientation >= 5 && orientation <= 8;
  const dstW = swap ? srcH : srcW;
  const dstH = swap ? srcW : srcH;
  const dst = new Uint8Array(dstW * dstH * 4);

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      let sx = dx;
      let sy = dy;
      switch (orientation) {
        case 2:
          sx = srcW - 1 - dx;
          sy = dy;
          break;
        case 3:
          sx = srcW - 1 - dx;
          sy = srcH - 1 - dy;
          break;
        case 4:
          sx = dx;
          sy = srcH - 1 - dy;
          break;
        case 5:
          sx = dy;
          sy = dx;
          break;
        case 6:
          sx = dy;
          sy = srcH - 1 - dx;
          break;
        case 7:
          sx = srcW - 1 - dy;
          sy = srcH - 1 - dx;
          break;
        case 8:
          sx = srcW - 1 - dy;
          sy = dx;
          break;
        default:
          return image;
      }
      copyPixel(src, (sy * srcW + sx) * 4, dst, (dy * dstW + dx) * 4);
    }
  }
  return { width: dstW, height: dstH, data: dst };
}
