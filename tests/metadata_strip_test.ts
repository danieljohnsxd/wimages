/**
 * `keepMetadata: false` must never hand back EXIF GPS, XMP, or text — even when
 * the lossless rewrite is not smaller and the input bytes would otherwise be
 * returned as-is. The ICC profile and orientation survive (they define how the
 * pixels look).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import {
  createPixelBuffer,
  decodeGif,
  decodeJpeg,
  decodePng,
  encodeGif,
  encodeJpeg,
  exifOrientation,
  optimizeImage,
  readImageMetadata,
  shrinkImage,
} from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import { assemblePng, buildExifTiff } from "./png_decode_helper.ts";

const GPS = "GPSLAT=48.8584N GPSLON=2.2945E";
const ICC = Uint8Array.from({ length: 300 }, (_, i) => (i * 13 + 5) & 0xff);

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function contains(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes).includes(needle, 0, "latin1");
}

function photo(w: number, h: number): PixelBuffer {
  const img = createPixelBuffer(w, h);
  let seed = 7;
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = i % w;
    const y = Math.floor(i / w);
    img.data[i * 4] = (128 + 60 * Math.sin(x / 9) + (seed >>> 28)) & 255;
    img.data[i * 4 + 1] = (100 + 50 * Math.cos(y / 7)) & 255;
    img.data[i * 4 + 2] = (x * 3 + y) & 255;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

/** EXIF with orientation + a GPS-looking string in the TIFF payload. */
function gpsExif(orientation: number): Uint8Array {
  const tiff = buildExifTiff(orientation);
  const out = new Uint8Array(tiff.length + GPS.length);
  out.set(tiff);
  out.set(ascii(GPS), tiff.length);
  return out;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (payload.length + 2) >> 8;
  out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

function afterSoi(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

test("optimizeImage: progressive JPEG with GPS EXIF that cannot be beaten is stripped, not returned", () => {
  const img = photo(96, 64);
  // Our own progressive output is already optimal; a baseline transcode is larger,
  // which is exactly when the original bytes used to come back with their EXIF.
  const jpeg = encodeJpeg(img, {
    quality: 85,
    progressive: true,
    metadata: { exif: gpsExif(6), icc: ICC, xmp: ascii("<x:xmpmeta>secret</x:xmpmeta>") },
  });
  const withExtras = Buffer.concat([
    afterSoi(jpeg, segment(0xfe, ascii("comment: home address"))),
    ascii(`trailing MPF image ${GPS}`),
  ]);
  assert.ok(contains(withExtras, GPS));

  const out = optimizeImage(withExtras);
  assert.equal(out.changed, true);
  assert.equal(contains(out.bytes, GPS), false);
  assert.equal(contains(out.bytes, "secret"), false);
  assert.equal(contains(out.bytes, "home address"), false);
  const meta = readImageMetadata(out.bytes);
  assert.deepEqual(meta.icc, ICC);
  assert.equal(meta.xmp, undefined);
  assert.equal(exifOrientation(meta.exif), 6);
  assert.deepEqual(decodeJpeg(out.bytes).data, decodeJpeg(withExtras).data);

  const kept = optimizeImage(withExtras, { keepMetadata: true });
  assert.ok(contains(kept.bytes, GPS));
});

test("optimizeImage: an already-optimal JPEG without metadata comes back untouched", () => {
  const jpeg = optimizeImage(encodeJpeg(photo(64, 48), { quality: 85 })).bytes;
  const out = optimizeImage(jpeg);
  assert.equal(out.changed, false);
  assert.equal(out.bytes, jpeg);
});

test("optimizeImage: 16-bit PNG keeps its samples but loses eXIf / tEXt / iTXt / zTXt", () => {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 8);
  view.setUint32(4, 8);
  ihdr[8] = 16;
  ihdr[9] = 2;
  const raw = new Uint8Array(8 * (1 + 8 * 6));
  for (let i = 0; i < raw.length; i++) {
    raw[i] = i % 49 === 0 ? 0 : (i * 7) & 255;
  }
  const iccp = Buffer.concat([ascii("P3\0\0"), zlib.deflateSync(ICC)]);
  const png = assemblePng([
    { type: "IHDR", data: ihdr },
    { type: "iCCP", data: iccp },
    { type: "eXIf", data: gpsExif(1) },
    { type: "tEXt", data: ascii("Comment\0secret@home") },
    { type: "zTXt", data: Buffer.concat([ascii("Author\0\0"), zlib.deflateSync("ztxt-name")]) },
    { type: "iTXt", data: ascii("XML:com.adobe.xmp\0\0\0\0\0xmp-secret") },
    { type: "IDAT", data: zlib.deflateSync(raw) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);

  const out = optimizeImage(png);
  assert.equal(out.changed, true);
  for (const secret of [GPS, "secret@home", "Author", "xmp-secret"]) {
    assert.equal(contains(out.bytes, secret), false, secret);
  }
  assert.equal(out.bytes[24], 16, "still 16-bit");
  assert.deepEqual(readImageMetadata(out.bytes).icc, ICC);
  assert.deepEqual(decodePng(out.bytes).data, decodePng(png).data);

  const shrunk = shrinkImage(png);
  assert.equal(contains(shrunk.bytes, GPS), false);
  assert.deepEqual(readImageMetadata(shrunk.bytes).icc, ICC);
});

test("optimizeImage: GIF comment and XMP application extensions are removed", () => {
  const frame = createPixelBuffer(4, 4);
  frame.data.fill(255);
  const gif = encodeGif([
    { ...frame, delay: 100 },
    { ...photo(4, 4), delay: 100 },
  ]);
  // Insert a comment and an "XMP DataXMP" application extension after the header + GCT.
  const packed = gif[10];
  assert.ok(packed !== undefined);
  const gctSize = 3 * (1 << ((packed & 7) + 1));
  const at = 13 + gctSize;
  const comment = [0x21, 0xfe, 11, ...ascii("secret@home"), 0];
  const xmp = [0x21, 0xff, 11, ...ascii("XMP DataXMP"), 10, ...ascii("xmp-secret"), 0];
  const tagged = Buffer.concat([
    gif.subarray(0, at),
    Buffer.from([...comment, ...xmp]),
    gif.subarray(at),
  ]);
  assert.equal(decodeGif(tagged).frames.length, 2);

  const out = optimizeImage(tagged);
  assert.equal(out.changed, true);
  assert.equal(contains(out.bytes, "secret@home"), false);
  assert.equal(contains(out.bytes, "xmp-secret"), false);
  assert.deepEqual(decodeGif(out.bytes).frames, decodeGif(tagged).frames);
});

test("shrinkImage keeps a Display P3-style ICC profile by default, on both paths", () => {
  const jpeg = encodeJpeg(photo(64, 48), { quality: 85, metadata: { icc: ICC, exif: gpsExif(1) } });
  for (const out of [shrinkImage(jpeg), shrinkImage(jpeg, { maxSide: 32 })]) {
    const meta = readImageMetadata(out.bytes);
    assert.deepEqual(meta.icc, ICC);
    assert.equal(contains(out.bytes, GPS), false);
  }
});
