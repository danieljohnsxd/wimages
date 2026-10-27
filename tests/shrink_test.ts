import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPixelBuffer,
  decodeApng,
  decodeGif,
  decodeImage,
  decodePng,
  encodeApng,
  encodeGif,
  encodeJpeg,
  encodePng,
  exifOrientation,
  optimizeImage,
  readImageMetadata,
  shrinkImage,
} from "../dist/index.js";
import { JPEG_QUALITY_LADDER, jpegQualityAttempts } from "../src/image.ts";
import { scaleQuantTable, STD_LUM_QUANT, ZIGZAG } from "../src/jpeg/tables.ts";
import type { PixelBuffer } from "../dist/index.js";

function setPixel(
  image: PixelBuffer,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const i = (y * image.width + x) * 4;
  image.data[i] = r;
  image.data[i + 1] = g;
  image.data[i + 2] = b;
  image.data[i + 3] = a;
}

function fillPixels(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): PixelBuffer {
  const image = createPixelBuffer(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      setPixel(image, x, y, r, g, b, a);
    }
  }
  return image;
}

function solid(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): PixelBuffer {
  return fillPixels(width, height, () => [r, g, b, a]);
}

function fillPhoto(width: number, height: number): PixelBuffer {
  const image = createPixelBuffer(width, height);
  const data = image.data;
  const xDen = width === 1 ? 1 : width - 1;
  const yDen = height === 1 ? 1 : height - 1;
  for (let y = 0; y < height; y++) {
    const gy = (y * 255) / yDen;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const gx = (x * 255) / xDen;
      const n = ((x * 374761393 + y * 668265263) >>> 0) & 31;
      data[i] = clampByte(gx * 0.55 + gy * 0.35 + n);
      data[i + 1] = clampByte(gx * 0.2 + gy * 0.55 + (31 - n));
      data[i + 2] = clampByte(200 - gx * 0.4 + gy * 0.15 + n);
      data[i + 3] = 255;
    }
  }
  return image;
}

function fillNoise(width: number, height: number, salt = 0): PixelBuffer {
  const image = createPixelBuffer(width, height);
  const data = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const n = (x * 374761393 + y * 668265263 + salt * 2147483647) >>> 0;
      data[i] = n & 255;
      data[i + 1] = (n >>> 8) & 255;
      data[i + 2] = (n >>> 16) & 255;
      data[i + 3] = 255;
    }
  }
  return image;
}

/** Flat regions plus a thin many-color fringe (screenshot/UI, >256 colors). */
function fillScreenshot(width: number, height: number): PixelBuffer {
  const image = createPixelBuffer(width, height);
  const data = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = 255;
      let g = 255;
      let b = 255;
      if (y < 20) {
        r = 40;
        g = 44;
        b = 52;
      } else if (x < 36) {
        r = 248;
        g = 248;
        b = 250;
      }
      if (y >= height - 2) {
        r = x & 255;
        g = y & 255;
        b = (x * 13 + y * 29) & 255;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return image;
}

function clampByte(n: number): number {
  if (n < 0) {
    return 0;
  }
  if (n > 255) {
    return 255;
  }
  return n | 0;
}

function uniqueColors(image: PixelBuffer): number {
  const seen = new Set<number>();
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 0;
    seen.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
  }
  return seen.size;
}

function buildExifTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  const w16 = (off: number, v: number): void => {
    tiff[off] = v & 0xff;
    tiff[off + 1] = (v >> 8) & 0xff;
  };
  const w32 = (off: number, v: number): void => {
    w16(off, v & 0xffff);
    w16(off + 2, (v >>> 16) & 0xffff);
  };
  w16(2, 42);
  w32(4, 8);
  w16(8, 1);
  w16(10, 0x0112);
  w16(12, 3);
  w32(14, 1);
  w16(18, orientation);
  w16(20, 0);
  w32(22, 0);
  return tiff;
}

function sum(values: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    n += values[i] ?? 0;
  }
  return n;
}

function lumaDqt(jpeg: Uint8Array): Uint8Array {
  let i = 2;
  while (i + 4 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1];
    if (marker === undefined || marker === 0xda) {
      break;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = ((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0);
    if (marker === 0xdb) {
      const info = jpeg[i + 4] ?? 0;
      const precision = info >> 4;
      const id = info & 0x0f;
      if (id === 0 && precision === 0 && i + 5 + 64 <= jpeg.length) {
        const zig = jpeg.subarray(i + 5, i + 69);
        const natural = new Uint8Array(64);
        for (let k = 0; k < 64; k++) {
          natural[ZIGZAG[k] ?? k] = zig[k] ?? 1;
        }
        return natural;
      }
    }
    i += 2 + len;
  }
  throw new Error("no luma DQT");
}

function qualityFromDqt(jpeg: Uint8Array): number {
  const table = lumaDqt(jpeg);
  const candidates = [90, 80, ...JPEG_QUALITY_LADDER, 65];
  for (let i = 0; i < candidates.length; i++) {
    const q = candidates[i];
    if (q === undefined) {
      continue;
    }
    const scaled = scaleQuantTable(STD_LUM_QUANT, q);
    let ok = true;
    for (let k = 0; k < 64; k++) {
      if (table[k] !== scaled[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return q;
    }
  }
  throw new Error(`unrecognized DQT (q00=${table[0]})`);
}

test("jpegQualityAttempts walks the ladder below the starting quality", () => {
  assert.deepEqual(jpegQualityAttempts("balanced"), ["balanced", 72, 65, 58, 50, 42, 35]);
  assert.deepEqual(jpegQualityAttempts("high"), ["high", 80, 72, 65, 58, 50, 42, 35]);
  assert.deepEqual(jpegQualityAttempts("small"), ["small", 58, 50, 42, 35]);
  assert.deepEqual(jpegQualityAttempts(90), [90, 80, 72, 65, 58, 50, 42, 35]);
});

test("shrinkImage JPEG output DQT matches a ladder quality that was actually tried", () => {
  const src = fillNoise(48, 48);
  const jpeg = encodeJpeg(src, { quality: "high" });
  const result = shrinkImage(jpeg, { maxSide: 48, maxBytes: 2800, quality: "balanced" });
  assert.equal(result.format, "jpeg");
  assert.ok(result.bytes.length <= 2800);
  const q = qualityFromDqt(result.bytes);
  const tried = jpegQualityAttempts("balanced").map((step) =>
    step === "balanced" ? 80 : step === "small" ? 65 : step === "high" ? 90 : step,
  );
  assert.ok(tried.includes(q), `output quality ${q} was not in ${tried.join(",")}`);
});

test("quality ladder is fully walked at the next ×0.8 size instead of aborting", () => {
  const src = fillNoise(512, 512);
  const jpeg = encodeJpeg(src, { quality: "high" });
  const q35at512 = encodeJpeg(src, { quality: 35 }).length;
  const maxBytes = Math.min(q35at512 - 1, 40_000);
  const result = shrinkImage(jpeg, { maxSide: 512, maxBytes, quality: "balanced" });
  assert.ok(result.bytes.length <= maxBytes);
  assert.ok(Math.max(result.width, result.height) < 512);
  assert.ok(Math.max(result.width, result.height) >= 256);
  assert.equal(result.lossless, false);
});

test("screenshot-like PNG with >256 colors stays PNG under auto", () => {
  const src = fillScreenshot(160, 100);
  assert.ok(uniqueColors(src) > 256);
  const png = encodePng(src);
  const result = shrinkImage(png);
  assert.equal(result.format, "png");
});

test("photographic PNG with >256 colors becomes JPEG under auto", () => {
  const src = fillPhoto(80, 60);
  assert.ok(uniqueColors(src) > 256);
  const png = encodePng(src);
  const result = shrinkImage(png);
  assert.equal(result.format, "jpeg");
  assert.equal(result.lossless, false);
});

test("play-once GIF stays play-once after shrinkImage", () => {
  const frames = [
    { ...solid(12, 10, 200, 20, 20), delay: 80 },
    { ...solid(12, 10, 20, 20, 200), delay: 80 },
  ];
  const gif = encodeGif(frames);
  assert.equal(decodeGif(gif).loop, undefined);
  const result = shrinkImage(gif, { format: "keep", maxSide: 12 });
  assert.equal(result.format, "gif");
  assert.equal(result.lossless, true);
  assert.equal(decodeGif(result.bytes).loop, undefined);
});

test("loop 0 (forever) and loop n pass through shrinkImage", () => {
  const frames = [
    { ...solid(8, 8, 10, 20, 30), delay: 40 },
    { ...solid(8, 8, 30, 20, 10), delay: 40 },
  ];
  const forever = encodeGif(frames, { loop: 0 });
  assert.equal(decodeGif(forever).loop, 0);
  assert.equal(decodeGif(shrinkImage(forever, { format: "keep" }).bytes).loop, 0);

  const three = encodeGif(frames, { loop: 3 });
  assert.equal(decodeGif(three).loop, 3);
  assert.equal(decodeGif(shrinkImage(three, { format: "keep" }).bytes).loop, 3);
});

test("GIF delay ≤ 10 ms becomes 100 ms when written as APNG", () => {
  const gif = encodeGif(
    [
      { ...solid(10, 8, 220, 20, 20), delay: 0 },
      { ...solid(10, 8, 20, 20, 220), delay: 10 },
    ],
    { loop: 0 },
  );
  assert.deepEqual(decodeGif(gif).delays, [0, 10]);
  const apng = shrinkImage(gif, { format: "png" });
  assert.equal(apng.format, "png");
  assert.deepEqual(decodeApng(apng.bytes).delays, [100, 100]);
});

test("APNG delay ≤ 10 ms becomes 100 ms when written as GIF", () => {
  const apng = encodeApng(
    [
      { image: solid(10, 8, 220, 20, 20), delay: 0 },
      { image: solid(10, 8, 20, 20, 220), delay: 8 },
    ],
    { loop: 0 },
  );
  assert.deepEqual(decodeApng(apng).delays, [0, 8]);
  const gif = shrinkImage(apng, { format: "gif" });
  assert.equal(gif.format, "gif");
  assert.deepEqual(decodeGif(gif.bytes).delays, [100, 100]);
});

test("dropEveryOther sums delays and preserves total duration, including an odd tail", () => {
  const list = [
    { ...fillNoise(32, 32, 1), delay: 50 },
    { ...fillNoise(32, 32, 2), delay: 150 },
    { ...fillNoise(32, 32, 3), delay: 50 },
    { ...fillNoise(32, 32, 4), delay: 150 },
    { ...fillNoise(32, 32, 5), delay: 80 },
  ];
  const gif = encodeGif(list, { loop: 0, dither: "none" });
  const source = decodeGif(gif);
  assert.equal(source.frames.length, 5);
  const originalDuration = sum(source.delays);
  const five64 = encodeGif(list, {
    loop: 0,
    dither: "floyd-steinberg",
    maxColors: 64,
    palette: "local",
  });
  const frame0 = list[0];
  const frame2 = list[2];
  const frame4 = list[4];
  if (frame0 === undefined || frame2 === undefined || frame4 === undefined) {
    throw new Error("expected five frames");
  }
  const three = [
    { ...frame0, delay: 200 },
    { ...frame2, delay: 200 },
    { ...frame4, delay: 80 },
  ];
  const three64 = encodeGif(three, {
    loop: 0,
    dither: "floyd-steinberg",
    maxColors: 64,
    palette: "local",
  });
  assert.ok(five64.length > three64.length);
  const maxBytes = three64.length + Math.floor((five64.length - three64.length) / 2);
  const result = shrinkImage(gif, { maxSide: 32, maxBytes, format: "keep" });
  assert.equal(result.format, "gif");
  const out = decodeGif(result.bytes);
  assert.ok(
    out.frames.length < 5,
    `still ${out.frames.length} frames, ${result.bytes.length} bytes`,
  );
  assert.ok(out.frames.length >= 2);
  assert.equal(sum(out.delays), originalDuration);
});

test("PNG eXIf orientation 6 is applied, kept as a tag on lossless, baked on lossy", () => {
  const src = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const png = encodePng(src, { metadata: { exif: buildExifTiff(6) } });

  const decoded = decodeImage(png);
  assert.equal(decoded.image.width, 4);
  assert.equal(decoded.image.height, 8);

  const optimized = optimizeImage(png);
  const optDecoded = decodePng(optimized.bytes);
  assert.equal(optDecoded.width, 4);
  assert.equal(optDecoded.height, 8);
  if (optimized.changed) {
    assert.equal(exifOrientation(readImageMetadata(optimized.bytes).exif), 6);
    const ignored = decodePng(optimized.bytes, { orientation: "ignore" });
    assert.equal(ignored.width, 8);
    assert.equal(ignored.height, 4);
  }

  const lossless = shrinkImage(png, { format: "png" });
  assert.equal(lossless.lossless, true);
  assert.equal(lossless.width, 4);
  assert.equal(lossless.height, 8);
  assert.equal(exifOrientation(readImageMetadata(lossless.bytes).exif), 6);
  assert.deepEqual(decodePng(lossless.bytes).data, decoded.image.data);

  const lossy = shrinkImage(png, { format: "png", keepMetadata: true, maxSide: 4 });
  assert.equal(lossy.lossless, false);
  assert.equal(Math.max(lossy.width, lossy.height), 4);
  assert.equal(exifOrientation(readImageMetadata(lossy.bytes).exif), 1);
  const baked = decodePng(lossy.bytes, { orientation: "ignore" });
  assert.equal(baked.width, lossy.width);
  assert.equal(baked.height, lossy.height);
});

test("optimizeImage and shrinkImage forward maxPixels to GIF and PNG", () => {
  const gif = encodeGif([
    { ...solid(8, 8, 1, 2, 3), delay: 40 },
    { ...solid(8, 8, 3, 2, 1), delay: 40 },
  ]);
  assert.throws(() => optimizeImage(gif, { maxPixels: 10 }), /maxPixels/);
  assert.throws(() => shrinkImage(gif, { maxPixels: 10 }), /maxPixels/);

  const png = encodePng(solid(8, 8, 1, 2, 3));
  assert.throws(() => optimizeImage(png, { maxPixels: 10 }), /maxPixels/);
  assert.throws(() => shrinkImage(png, { maxPixels: 10 }), /maxPixels/);
  assert.throws(() => readImageMetadata(png, { maxPixels: 10 }), /maxPixels/);
});

test("shrinkImage names WebP/HEIC on the product path", () => {
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.throws(() => shrinkImage(webp), /shrinkImage: WebP is not supported/);
  const mif1 = new Uint8Array(12);
  mif1.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]);
  assert.throws(() => shrinkImage(mif1), /shrinkImage: HEIC is not supported/);
});
