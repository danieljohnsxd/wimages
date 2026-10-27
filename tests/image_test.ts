import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import {
  createPixelBuffer,
  decodeApng,
  decodeGif,
  decodeImage,
  decodeJpeg,
  decodePng,
  encodeApng,
  encodeGif,
  encodeJpeg,
  encodePng,
  exifOrientation,
  isAnimatedPng,
  optimizeImage,
  readImageMetadata,
  shrinkImage,
  sniffImageFormat,
} from "../dist/index.js";
import { DEFAULT_MAX_BYTES } from "../src/image.ts";
import type { ImageMetadata, PixelBuffer } from "../dist/index.js";
import { assemblePng, writeUint32BE } from "./png_decode_helper.ts";
import { untyped } from "./untyped.ts";

/** Same libjpeg-turbo restart fixture as jpeg_transcode_test.ts (standard Huffman tables). */
const RESTART_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAdACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAD/9oADAMBAAIRAxEAPwDibCw6cV0lhYdOKpWAl4+RPyNaq6xDZ/LhJZR/Ag6H3Pbp9favQxGLwU3aKf3HsTwEKEOeq0l5m5YWHTitAX1tbqVgxNLjjbyoPuf8P0rlRqd9fMQ+1IieI1zjHv69K2LAS8fIn5GvGrPALWbf3HzeLx1SV4YWNvN7/Jf5/caqzX0/zmeRPRYyVA/KirdsJfL+4n5GivPeKy5PZ/ceC8FipO7k7+rP/9DkftdxegIq+TF3VTyeO57960rCw6cVmWDScfP/AOOiuksGk4+f/wAdFehiMywEFaMJfcv8z0KmCrYifPVldmnYWHTiujsrJUXc2FUDJJ6AViG7ls7F7hSGZAMAgYyTj+tV49Rvb1gZ5yVzkIFAUfh+NeDUxmDq3fLK3ov8zy8wlTwDUGryavbp951z6lbwYSCL7Rj7zBsAfTjmism2aTy/v/8AjoorheKyxbwl+H/yR8zPF5hKTcZpLskv1TZ//9k=";

const SAMPLE_XMP =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

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

/** Smooth gradient plus cheap low-amplitude noise — photo-like, JPEG-friendly. */
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

function hasAlpha(image: PixelBuffer): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) {
      return true;
    }
  }
  return false;
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function patternBytes(length: number, salt: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 7 + salt) & 0xff;
  }
  return out;
}

function sampleMetadata(orientation: number): ImageMetadata {
  return {
    exif: buildExifTiff(orientation),
    icc: patternBytes(512, 11),
    xmp: ascii(SAMPLE_XMP),
  };
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

function buildExifApp1(orientation: number): Uint8Array {
  const tiff = buildExifTiff(orientation);
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  payload.set(tiff, 6);
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  const len = payload.length + 2;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

function spliceAfterSoi(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

function assertMetaEqual(a: ImageMetadata, b: ImageMetadata, label: string): void {
  assert.deepEqual(a.exif, b.exif, `${label} exif`);
  assert.deepEqual(a.icc, b.icc, `${label} icc`);
  assert.deepEqual(a.xmp, b.xmp, `${label} xmp`);
}

/** Default strip: EXIF (except orientation) and XMP go; the ICC profile stays. */
function assertStripped(bytes: Uint8Array, rotatedJpeg: boolean, icc?: Uint8Array): void {
  const meta = readImageMetadata(bytes);
  assert.deepEqual(meta.icc, icc);
  assert.equal(meta.xmp, undefined);
  if (rotatedJpeg) {
    assert.equal(exifOrientation(meta.exif), 6);
  } else {
    assert.equal(meta.exif, undefined);
  }
}

function gray16x1Png(): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, 1);
  writeUint32BE(ihdr, 4, 1);
  ihdr[8] = 16;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scan = new Uint8Array([0, 0x12, 0x34]);
  return assemblePng([
    { type: "IHDR", data: ihdr },
    { type: "IDAT", data: new Uint8Array(deflateSync(scan)) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
}

function twoFrameGif(width: number, height: number): Uint8Array {
  return encodeGif(
    [
      { ...solid(width, height, 220, 20, 20), delay: 10 },
      { ...solid(width, height, 20, 20, 220), delay: 10 },
    ],
    { loop: 0 },
  );
}

function noisyGif(frames: number, width: number, height: number): Uint8Array {
  const list = [];
  for (let i = 0; i < frames; i++) {
    list.push({ ...fillNoise(width, height, i + 1), delay: 8 });
  }
  return encodeGif(list, { loop: 0, dither: "none" });
}

function twoFrameApng(
  width: number,
  height: number,
  effort: "fast" | "strong" = "fast",
): Uint8Array {
  return encodeApng(
    [
      { image: solid(width, height, 220, 20, 20), delay: 100 },
      { image: solid(width, height, 20, 20, 220), delay: 100 },
    ],
    { loop: 0, effort },
  );
}

test("sniffImageFormat recognizes PNG, JPEG, GIF87a/89a, and rejects unknown", () => {
  const png = encodePng(solid(1, 1, 0, 0, 0));
  const jpeg = encodeJpeg(solid(1, 1, 0, 0, 0));
  const gif = encodeGif(solid(1, 1, 255, 0, 0));
  assert.equal(sniffImageFormat(png), "png");
  assert.equal(sniffImageFormat(jpeg), "jpeg");
  assert.equal(sniffImageFormat(gif), "gif");
  assert.equal(sniffImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), "gif");
  assert.equal(sniffImageFormat(new Uint8Array([0xff, 0xd8])), "jpeg");
  assert.equal(sniffImageFormat(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(sniffImageFormat(new Uint8Array()), null);
});

test("decodeImage throws on unknown bytes", () => {
  assert.throws(
    () => decodeImage(new Uint8Array([0, 1, 2, 3, 4])),
    /decodeImage: unknown image format/,
  );
});

test("decodeImage names recognizable unsupported formats", () => {
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.throws(() => decodeImage(webp), /decodeImage: WebP is not supported/);
  const heic = new Uint8Array(12);
  heic.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  assert.throws(() => decodeImage(heic), /decodeImage: HEIC is not supported/);
  const avif = new Uint8Array(12);
  avif.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
  assert.throws(() => decodeImage(avif), /decodeImage: AVIF is not supported/);
  assert.throws(
    () => decodeImage(new Uint8Array([0x42, 0x4d, 0, 0])),
    /decodeImage: BMP is not supported/,
  );
  assert.throws(
    () => decodeImage(new Uint8Array([0x49, 0x49, 0x2a, 0x00])),
    /decodeImage: TIFF is not supported/,
  );
  assert.throws(
    () => decodeImage(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a])),
    /decodeImage: TIFF is not supported/,
  );
});

test("decodeImage leaves unsupported JPEG variant messages intact", () => {
  const sof3 = Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc3,
    0x00,
    0x0b,
    8,
    0x00,
    0x01,
    0x00,
    0x01,
    0x01,
    0x01,
    0x11,
    0x00,
  );
  assert.throws(
    () => decodeImage(sof3),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "JPEG: lossless (SOF3) is not supported");
      return true;
    },
  );
});

test("decodeImage PNG / JPEG / GIF first frame", () => {
  const png = encodePng(solid(3, 2, 10, 20, 30));
  const pngDec = decodeImage(png);
  assert.equal(pngDec.format, "png");
  assert.equal(pngDec.animated, false);
  assert.equal(pngDec.image.width, 3);
  assert.equal(pngDec.image.height, 2);

  const jpeg = encodeJpeg(solid(4, 2, 200, 10, 10), { quality: "high" });
  const jpegDec = decodeImage(jpeg);
  assert.equal(jpegDec.format, "jpeg");
  assert.equal(jpegDec.animated, false);
  assert.equal(jpegDec.image.width, 4);

  const gif = encodeGif(solid(5, 3, 0, 180, 0));
  const gifDec = decodeImage(gif);
  assert.equal(gifDec.format, "gif");
  assert.equal(gifDec.animated, false);
  assert.equal(gifDec.image.width, 5);
  assert.equal(gifDec.image.height, 3);
});

test("decodeImage marks multi-frame GIF and APNG as animated and returns frame 1", () => {
  const gif = twoFrameGif(8, 6);
  const gifDec = decodeImage(gif);
  assert.equal(gifDec.format, "gif");
  assert.equal(gifDec.animated, true);
  assert.equal(gifDec.image.width, 8);
  assert.deepEqual(gifDec.image.data, decodeGif(gif).frames[0]?.data);

  const apng = twoFrameApng(8, 6);
  const apngDec = decodeImage(apng);
  assert.equal(apngDec.format, "png");
  assert.equal(apngDec.animated, true);
  assert.equal(apngDec.image.width, 8);
});

test("decodeImage applies JPEG EXIF orientation", () => {
  const src = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const jpeg = encodeJpeg(src, { quality: 95, chroma: "4:4:4" });
  const withExif = spliceAfterSoi(jpeg, buildExifApp1(6));
  const applied = decodeImage(withExif);
  assert.equal(applied.format, "jpeg");
  assert.equal(applied.animated, false);
  assert.equal(applied.image.width, 4);
  assert.equal(applied.image.height, 8);
});

test("decodeImage applies PNG eXIf orientation 6", () => {
  const src = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const png = encodePng(src, { metadata: { exif: buildExifTiff(6) } });
  const applied = decodeImage(png);
  assert.equal(applied.format, "png");
  assert.equal(applied.image.width, 4);
  assert.equal(applied.image.height, 8);
  const ignored = decodePng(png, { orientation: "ignore" });
  assert.equal(ignored.width, 8);
  assert.equal(ignored.height, 4);
});

test("decodeImage forwards maxPixels", () => {
  const jpeg = encodeJpeg(solid(8, 8, 1, 2, 3));
  assert.throws(() => decodeImage(jpeg, { maxPixels: 10 }), /maxPixels/);
});

test("optimizeImage on a strong PNG returns the same object", () => {
  const png = encodePng(solid(12, 8, 10, 20, 30), { effort: "strong" });
  const result = optimizeImage(png);
  assert.equal(result.changed, false);
  assert.equal(result.format, "png");
  assert.equal(result.animated, false);
  assert.equal(result.bytes, png);
});

test("optimizeImage on a fast PNG returns smaller pixel-identical bytes", () => {
  const src = fillPhoto(48, 32);
  const png = encodePng(src, { effort: "fast" });
  const result = optimizeImage(png);
  assert.equal(result.changed, true);
  assert.equal(result.format, "png");
  assert.ok(result.bytes.length < png.length);
  assert.deepEqual(decodePng(result.bytes).data, decodePng(png).data);
});

test("optimizeImage on a standard-Huffman JPEG returns smaller bit-identical pixels", () => {
  const jpeg = fromB64(RESTART_JPEG);
  const result = optimizeImage(jpeg);
  assert.equal(result.format, "jpeg");
  assert.equal(result.changed, true);
  assert.ok(result.bytes.length < jpeg.length);
  assert.deepEqual(decodeJpeg(result.bytes).data, decodeJpeg(jpeg).data);
});

test("optimizeImage on a compact GIF returns the input", () => {
  const gif = encodeGif(solid(6, 4, 255, 0, 0));
  const result = optimizeImage(gif);
  assert.equal(result.format, "gif");
  assert.equal(result.animated, false);
  assert.equal(result.changed, false);
  assert.equal(result.bytes, gif);
});

test("optimizeImage on a metadata-free 16-bit PNG returns the input", () => {
  const png = gray16x1Png();
  const decoded = decodePng(png);
  assert.deepEqual([...decoded.data], [0x12, 0x12, 0x12, 255]);
  const result = optimizeImage(png);
  assert.equal(result.changed, false);
  assert.equal(result.format, "png");
  assert.equal(result.bytes, png);
});

test("optimizeImage keepMetadata preserves EXIF/ICC/XMP; default strips EXIF/XMP, keeps ICC", () => {
  const img = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const metadata = sampleMetadata(1);

  const png = encodePng(img, { effort: "fast", metadata });
  const pngKept = optimizeImage(png, { keepMetadata: true });
  assertMetaEqual(readImageMetadata(pngKept.bytes), readImageMetadata(png), "png keep");
  const pngStripped = optimizeImage(png);
  assert.equal(pngStripped.changed, true);
  assertStripped(pngStripped.bytes, false, metadata.icc);

  const jpeg = encodeJpeg(img, { quality: 90, chroma: "4:4:4", metadata });
  const jpegKept = optimizeImage(jpeg, { keepMetadata: true });
  assertMetaEqual(readImageMetadata(jpegKept.bytes), readImageMetadata(jpeg), "jpeg keep");
  const jpegStripped = optimizeImage(jpeg);
  assertStripped(jpegStripped.bytes, false, metadata.icc);

  const rotated = spliceAfterSoi(
    encodeJpeg(img, { quality: 95, chroma: "4:4:4" }),
    buildExifApp1(6),
  );
  const rotatedOut = optimizeImage(rotated);
  assertStripped(rotatedOut.bytes, true);
});

test("shrinkImage keepMetadata preserves EXIF/ICC/XMP; default strips EXIF/XMP, keeps ICC", () => {
  const img = fillPhoto(24, 16);
  const metadata = sampleMetadata(1);
  const png = encodePng(img, { effort: "fast", metadata });
  const pngKept = shrinkImage(png, { format: "png", keepMetadata: true });
  assertMetaEqual(readImageMetadata(pngKept.bytes), readImageMetadata(png), "png shrink keep");
  const pngStripped = shrinkImage(png, { format: "png" });
  assertStripped(pngStripped.bytes, false, metadata.icc);

  const jpeg = encodeJpeg(img, { quality: "balanced", metadata });
  const jpegKept = shrinkImage(jpeg, { keepMetadata: true });
  assertMetaEqual(readImageMetadata(jpegKept.bytes), readImageMetadata(jpeg), "jpeg shrink keep");
  const jpegStripped = shrinkImage(jpeg);
  assertStripped(jpegStripped.bytes, false, metadata.icc);
  // The lossy path keeps it too.
  const jpegLossy = shrinkImage(jpeg, { maxSide: 12 });
  assert.equal(jpegLossy.lossless, false);
  assertStripped(jpegLossy.bytes, false, metadata.icc);
});

test("small JPEG that already fits is re-emitted with identical pixels", () => {
  const jpeg = encodeJpeg(solid(32, 24, 40, 80, 120), { quality: "balanced" });
  const result = shrinkImage(jpeg);
  assert.equal(result.lossless, true);
  assert.equal(result.format, "jpeg");
  assert.equal(result.animated, false);
  assert.equal(result.width, 32);
  assert.equal(result.height, 24);
  assert.notEqual(result.bytes, jpeg);
  assert.deepEqual(decodeJpeg(result.bytes).data, decodeJpeg(jpeg).data);
  assertStripped(result.bytes, false);
});

test("PNG with alpha stays PNG", () => {
  const src = fillPixels(12, 10, (x, y) => [40, 80, 160, x === 0 && y === 0 ? 128 : 255]);
  const png = encodePng(src);
  const result = shrinkImage(png);
  assert.equal(result.format, "png");
  assert.equal(result.lossless, true);
  assert.notEqual(result.bytes, png);
  const decoded = decodePng(result.bytes);
  assert.ok(hasAlpha(decoded));
});

test("opaque 300-color PNG becomes JPEG under auto", () => {
  const src = fillPixels(40, 30, (x, y) => {
    const i = (y * 40 + x) % 300;
    return [i % 256, Math.floor(i / 256), 90, 255];
  });
  assert.equal(uniqueColors(src), 300);
  const png = encodePng(src);
  const result = shrinkImage(png);
  assert.equal(result.format, "jpeg");
  assert.equal(result.lossless, false);
  assert.equal(sniffImageFormat(result.bytes), "jpeg");
  const decoded = decodeJpeg(result.bytes);
  assert.equal(decoded.width, 40);
  assert.equal(decoded.height, 30);
});

test('format: "png" forces PNG', () => {
  const jpeg = encodeJpeg(fillPhoto(24, 16), { quality: "balanced" });
  const result = shrinkImage(jpeg, { format: "png" });
  assert.equal(result.format, "png");
  assert.equal(sniffImageFormat(result.bytes), "png");
  const decoded = decodePng(result.bytes);
  assert.equal(decoded.width, 24);
  assert.equal(decoded.height, 16);
});

test('format: "keep" keeps a still GIF as GIF', () => {
  const gif = encodeGif(solid(20, 12, 255, 128, 0));
  const result = shrinkImage(gif, { format: "keep" });
  assert.equal(result.format, "gif");
  assert.equal(result.animated, false);
  assert.equal(sniffImageFormat(result.bytes), "gif");
});

test("invalid format throws RangeError", () => {
  const jpeg = encodeJpeg(solid(4, 4, 1, 2, 3));
  assert.throws(
    () => shrinkImage(jpeg, { format: untyped("webp") }),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.match(err.message, /shrinkImage: format must be/);
      return true;
    },
  );
});

test("invalid quality throws even when the lossless path would succeed", () => {
  const jpeg = encodeJpeg(solid(8, 8, 1, 2, 3));
  assert.throws(
    () => shrinkImage(jpeg, { quality: untyped("ultra") }),
    /shrinkImage: quality must be/,
  );
  assert.throws(() => shrinkImage(jpeg, { quality: 0 }), /shrinkImage: quality must be/);
  assert.throws(() => shrinkImage(jpeg, { quality: 101 }), /shrinkImage: quality must be/);
});

test("invalid maxSide, maxBytes, maxPixels, keepMetadata throw named RangeErrors", () => {
  const jpeg = encodeJpeg(solid(4, 4, 1, 2, 3));
  assert.throws(() => shrinkImage(jpeg, { maxSide: 0 }), /shrinkImage: maxSide/);
  assert.throws(() => shrinkImage(jpeg, { maxBytes: -1 }), /shrinkImage: maxBytes/);
  assert.throws(() => shrinkImage(jpeg, { maxPixels: 0 }), /shrinkImage: maxPixels/);
  assert.throws(
    () => shrinkImage(jpeg, { keepMetadata: untyped("yes") }),
    /shrinkImage: keepMetadata/,
  );
});

test("GIF still under auto outputs jpeg or png", () => {
  const gif = encodeGif(solid(20, 12, 255, 128, 0));
  const result = shrinkImage(gif);
  assert.equal(result.format, "png");
  assert.equal(result.lossless, false);
  assert.equal(result.animated, false);
  assert.equal(sniffImageFormat(result.bytes), result.format);
  const decoded = decodeImage(result.bytes);
  assert.equal(decoded.image.width, 20);
  assert.equal(decoded.image.height, 12);
});

test("EXIF orientation 6 shrinks to displayed dimensions and decodes upright", () => {
  const src = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const jpeg = encodeJpeg(src, { quality: 95, chroma: "4:4:4" });
  const withExif = spliceAfterSoi(jpeg, buildExifApp1(6));
  const result = shrinkImage(withExif);
  assert.equal(result.width, 4);
  assert.equal(result.height, 8);
  const decoded = decodeJpeg(result.bytes);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 8);
  assert.deepEqual(decoded.data, decodeImage(withExif).image.data);
});

test("lossy shrinkImage keepMetadata bakes orientation 6 into pixels and writes orientation 1", () => {
  const src = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const jpeg = encodeJpeg(src, { quality: 95, chroma: "4:4:4", metadata: sampleMetadata(6) });
  const result = shrinkImage(jpeg, { keepMetadata: true, maxSide: 4, format: "jpeg" });
  assert.equal(result.lossless, false);
  assert.equal(Math.max(result.width, result.height), 4);
  const decoded = decodeJpeg(result.bytes);
  assert.equal(decoded.width, result.width);
  assert.equal(decoded.height, result.height);
  const meta = readImageMetadata(result.bytes);
  assert.equal(exifOrientation(meta.exif), 1);
  assert.ok(meta.icc !== undefined);
  assert.ok(meta.xmp !== undefined);
});

test("3000×2000 synthetic photo JPEG shrinks to ≤2048 long side and ≤1 MiB", () => {
  const jpeg = encodeJpeg(fillPhoto(3000, 2000), { quality: "balanced" });
  const result = shrinkImage(jpeg);
  assert.equal(result.lossless, false);
  assert.equal(result.format, "jpeg");
  assert.equal(Math.max(result.width, result.height), 2048);
  assert.equal(result.width, 2048);
  assert.equal(result.height, 1365);
  assert.ok(result.bytes.length <= DEFAULT_MAX_BYTES);
  assertStripped(result.bytes, false);
  const decoded = decodeJpeg(result.bytes);
  assert.equal(decoded.width, result.width);
  assert.equal(decoded.height, result.height);
});

test("tiny maxBytes on a noisy image walks down to the 256 px floor, then throws", () => {
  // Noise cannot reach 3 KB even at 256 px and q35: the documented failure, not a silent pass.
  const jpeg = encodeJpeg(fillNoise(400, 400), { quality: "high" });
  assert.throws(
    () => shrinkImage(jpeg, { maxSide: 400, maxBytes: 3072 }),
    /shrinkImage: cannot fit 256x256 within maxBytes \(3072\)/,
  );
});

test("animated GIF that already fits stays a GIF with the same frame count", () => {
  const gif = twoFrameGif(24, 16);
  const result = shrinkImage(gif);
  assert.equal(result.format, "gif");
  assert.equal(result.animated, true);
  assert.equal(result.lossless, true);
  assert.notEqual(result.bytes, gif);
  assert.equal(decodeGif(result.bytes).frames.length, 2);
  assert.equal(result.width, 24);
  assert.equal(result.height, 16);
});

test("animated GIF under a tight maxBytes drops frames", () => {
  const gif = noisyGif(8, 48, 48);
  const result = shrinkImage(gif, { maxSide: 48, maxBytes: 8000 });
  assert.equal(result.format, "gif");
  assert.equal(result.animated, true);
  assert.ok(decodeGif(result.bytes).frames.length < 8);
  assert.ok(decodeGif(result.bytes).frames.length >= 2);
  assert.ok(result.bytes.length <= 8000);
});

test('format: "png" on an animated GIF yields an APNG', () => {
  const gif = twoFrameGif(16, 12);
  const result = shrinkImage(gif, { format: "png" });
  assert.equal(result.format, "png");
  assert.equal(result.animated, true);
  assert.equal(result.lossless, false);
  assert.ok(isAnimatedPng(result.bytes));
  assert.equal(decodeApng(result.bytes).frames.length, 2);
});

test('format: "jpeg" on an animated GIF yields the first frame', () => {
  const gif = twoFrameGif(16, 12);
  const result = shrinkImage(gif, { format: "jpeg" });
  assert.equal(result.format, "jpeg");
  assert.equal(result.animated, false);
  assert.equal(result.lossless, false);
  assert.equal(decodeJpeg(result.bytes).width, 16);
});

test("optimizeImage re-encodes a fast APNG; shrink keeps it animated", () => {
  const apng = twoFrameApng(20, 16, "fast");
  const optimized = optimizeImage(apng);
  assert.equal(optimized.format, "png");
  assert.equal(optimized.animated, true);
  assert.equal(optimized.changed, true);
  assert.ok(optimized.bytes.length < apng.length);
  assert.equal(decodeApng(optimized.bytes).frames.length, 2);

  const shrunk = shrinkImage(apng);
  assert.equal(shrunk.format, "png");
  assert.equal(shrunk.animated, true);
  assert.ok(isAnimatedPng(shrunk.bytes));
  assert.equal(decodeApng(shrunk.bytes).frames.length, 2);
});

test('format: "gif" on an animated PNG converts the animation', () => {
  const apng = twoFrameApng(16, 12);
  const result = shrinkImage(apng, { format: "gif" });
  assert.equal(result.format, "gif");
  assert.equal(result.animated, true);
  assert.equal(decodeGif(result.bytes).frames.length, 2);
});
