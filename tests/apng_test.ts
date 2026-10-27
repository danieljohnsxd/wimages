import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import {
  createPixelBuffer,
  decodeApng,
  decodePng,
  encodeApng,
  encodePng,
  isAnimatedPng,
} from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import { assemblePng, buildExifTiff, parsePngChunks, writeUint32BE } from "./png_decode_helper.ts";

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

function fill(
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

function pixelAt(
  image: PixelBuffer,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [
    image.data[i] ?? 0,
    image.data[i + 1] ?? 0,
    image.data[i + 2] ?? 0,
    image.data[i + 3] ?? 0,
  ];
}

function writeUint16BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

function ihdrData(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const data = new Uint8Array(13);
  writeUint32BE(data, 0, width);
  writeUint32BE(data, 4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function actlData(numFrames: number, numPlays: number): Uint8Array {
  const data = new Uint8Array(8);
  writeUint32BE(data, 0, numFrames);
  writeUint32BE(data, 4, numPlays);
  return data;
}

function fctlData(
  seq: number,
  width: number,
  height: number,
  x: number,
  y: number,
  delayNum: number,
  delayDen: number,
  dispose: number,
  blend: number,
): Uint8Array {
  const data = new Uint8Array(26);
  writeUint32BE(data, 0, seq);
  writeUint32BE(data, 4, width);
  writeUint32BE(data, 8, height);
  writeUint32BE(data, 12, x);
  writeUint32BE(data, 16, y);
  writeUint16BE(data, 20, delayNum);
  writeUint16BE(data, 22, delayDen);
  data[24] = dispose;
  data[25] = blend;
  return data;
}

function zlibRgba(image: PixelBuffer): Uint8Array {
  const stride = 1 + image.width * 4;
  const raw = new Uint8Array(image.height * stride);
  for (let y = 0; y < image.height; y++) {
    raw[y * stride] = 0;
    raw.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * stride + 1);
  }
  return new Uint8Array(deflateSync(raw));
}

function fdatData(seq: number, zlib: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + zlib.length);
  writeUint32BE(data, 0, seq);
  data.set(zlib, 4);
  return data;
}

function spriteFrames(): PixelBuffer[] {
  const frames: PixelBuffer[] = [];
  for (let t = 0; t < 12; t++) {
    const ang = (t * Math.PI * 2) / 12;
    const sx = 32 + Math.round(Math.cos(ang) * 28);
    const sy = 32 + Math.round(Math.sin(ang) * 28);
    frames.push(
      fill(96, 96, (x, y) => {
        if (x >= sx && x < sx + 16 && y >= sy && y < sy + 16) {
          const lx = x - sx;
          const ly = y - sy;
          return [220, 40 + lx * 12, 80 + ly * 8, 255];
        }
        const n = (x * 37 + y * 91 + (x ^ y) * 13) & 255;
        return [n, (n * 3) & 255, 40 + ((x * 5 + y * 7) % 180), 255];
      }),
    );
  }
  return frames;
}

test("decodeApng roundtrips encodeApng of a moving sprite", () => {
  const images = spriteFrames();
  const frames = images.map((image, i) => ({ image, delay: 40 + i * 5 }));
  const naive = images.reduce((n, image) => n + encodePng(image).length, 0);
  const apng = encodeApng(frames, { loop: 0 });
  const decoded = decodeApng(apng);

  assert.equal(decoded.width, 96);
  assert.equal(decoded.height, 96);
  assert.equal(decoded.frames.length, 12);
  assert.equal(decoded.loop, 0);
  assert.deepEqual(
    decoded.delays,
    frames.map((f) => f.delay),
  );
  for (let i = 0; i < images.length; i++) {
    const got = decoded.frames[i];
    const src = images[i];
    assert.ok(got !== undefined && src !== undefined);
    assert.deepEqual(got.data, src.data);
  }
  assert.ok(
    apng.length * 3 <= naive,
    `optimized APNG ${apng.length}B should be ≥3× smaller than ${naive}B of concatenated PNGs`,
  );
  assert.equal(isAnimatedPng(apng), true);

  const first = decodePng(apng);
  assert.deepEqual(first.data, images[0]?.data);
});

test("still PNG through decodeApng is one frame with loop undefined", () => {
  const image = fill(6, 4, (x, y) => [x * 40, y * 50, 90, 255]);
  const png = encodePng(image);
  assert.equal(isAnimatedPng(png), false);
  const decoded = decodeApng(png);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.loop, undefined);
  assert.deepEqual(decoded.frames[0]?.data, image.data);
});

test("fade-in alpha animation roundtrips exactly", () => {
  const frames: Array<{ image: PixelBuffer; delay: number }> = [];
  for (let i = 1; i <= 8; i++) {
    const a = i * 32 - 1;
    frames.push({
      image: fill(16, 16, () => [200, 10, 30, a]),
      delay: 80,
    });
  }
  const apng = encodeApng(frames, { loop: 2 });
  const decoded = decodeApng(apng);
  assert.equal(decoded.frames.length, 8);
  assert.equal(decoded.loop, 2);
  assert.deepEqual(decoded.delays, [80, 80, 80, 80, 80, 80, 80, 80]);
  for (let i = 0; i < frames.length; i++) {
    const got = decoded.frames[i];
    const src = frames[i];
    assert.ok(got !== undefined && src !== undefined);
    assert.deepEqual(got.data, src.image.data);
  }
});

test("hand-built APNG with dispose_op 1 and blend_op 0 composites like a browser", () => {
  const frame0 = fill(4, 2, () => [200, 0, 0, 255]);
  const patch = fill(2, 2, () => [0, 200, 0, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(4, 2, 8, 6) },
    { type: "acTL", data: actlData(2, 0) },
    { type: "fcTL", data: fctlData(0, 4, 2, 0, 0, 10, 100, 1, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "fcTL", data: fctlData(1, 2, 2, 1, 0, 20, 100, 0, 0) },
    { type: "fdAT", data: fdatData(2, zlibRgba(patch)) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);

  const decoded = decodeApng(apng);
  assert.equal(decoded.frames.length, 2);
  assert.equal(decoded.loop, 0);
  assert.deepEqual(decoded.delays, [100, 200]);

  const a = decoded.frames[0];
  const b = decoded.frames[1];
  assert.ok(a !== undefined && b !== undefined);
  assert.deepEqual(a.data, frame0.data);
  for (const x of [0, 3]) {
    assert.deepEqual(pixelAt(b, x, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(b, x, 1), [0, 0, 0, 0]);
  }
  assert.deepEqual(pixelAt(b, 1, 0), [0, 200, 0, 255]);
  assert.deepEqual(pixelAt(b, 2, 0), [0, 200, 0, 255]);
  assert.deepEqual(pixelAt(b, 1, 1), [0, 200, 0, 255]);
  assert.deepEqual(pixelAt(b, 2, 1), [0, 200, 0, 255]);
});

test("out-of-canvas fcTL throws", () => {
  const frame0 = fill(8, 8, () => [10, 20, 30, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(8, 8, 8, 6) },
    { type: "acTL", data: actlData(2, 0) },
    { type: "fcTL", data: fctlData(0, 8, 8, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "fcTL", data: fctlData(1, 4, 4, 6, 0, 10, 100, 0, 0) },
    { type: "fdAT", data: fdatData(2, zlibRgba(fill(4, 4, () => [1, 2, 3, 255]))) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.throws(() => decodeApng(apng), /outside the canvas/);
});

test("bad sequence number throws", () => {
  const frame0 = fill(2, 2, () => [9, 8, 7, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(2, 2, 8, 6) },
    { type: "acTL", data: actlData(2, 0) },
    { type: "fcTL", data: fctlData(0, 2, 2, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "fcTL", data: fctlData(1, 2, 2, 0, 0, 10, 100, 0, 0) },
    { type: "fdAT", data: fdatData(5, zlibRgba(frame0)) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.throws(() => decodeApng(apng), /sequence number/);
});

test("65535×65535 canvas throws on maxPixels immediately", () => {
  const png = assemblePng([
    { type: "IHDR", data: ihdrData(65535, 65535, 8, 6) },
    { type: "acTL", data: actlData(2, 0) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  const start = Date.now();
  assert.throws(() => decodeApng(png), /maxPixels/);
  assert.ok(Date.now() - start < 1000);
});

test("encodeApng rejects mismatched frame sizes and empty input", () => {
  const a = createPixelBuffer(4, 4);
  const b = createPixelBuffer(3, 4);
  a.data.fill(255);
  b.data.fill(255);
  assert.throws(() => encodeApng([]), /at least one frame/);
  assert.throws(() => encodeApng([{ image: a }, { image: b }]), /match the first frame size/);
});

test("identical consecutive frames merge delays", () => {
  const image = fill(3, 3, () => [12, 34, 56, 255]);
  const apng = encodeApng([
    { image, delay: 40 },
    { image, delay: 60 },
    { image: fill(3, 3, () => [99, 0, 0, 255]), delay: 80 },
  ]);
  const decoded = decodeApng(apng);
  assert.equal(decoded.frames.length, 2);
  assert.deepEqual(decoded.delays, [100, 80]);
});

test("encodeApng default delay is 100ms and loop defaults to play once", () => {
  const a = fill(2, 2, () => [1, 2, 3, 255]);
  const b = fill(2, 2, () => [4, 5, 6, 255]);
  const decoded = decodeApng(encodeApng([{ image: a }, { image: b }]));
  assert.deepEqual(decoded.delays, [100, 100]);
  assert.equal(decoded.loop, 1);
  assert.equal(decodeApng(encodeApng([{ image: a }, { image: b }], { loop: 1 })).loop, 1);
  assert.equal(decodeApng(encodeApng([{ image: a }, { image: b }], { loop: 0 })).loop, 0);
  assert.equal(decodeApng(encodeApng([{ image: a }, { image: b }], { loop: 4 })).loop, 4);
});

test("fcTL delay_den 0 is treated as 100", () => {
  const frame0 = fill(1, 1, () => [1, 2, 3, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(1, 1, 8, 6) },
    { type: "acTL", data: actlData(1, 0) },
    { type: "fcTL", data: fctlData(0, 1, 1, 0, 0, 25, 0, 0, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  const decoded = decodeApng(apng);
  assert.deepEqual(decoded.delays, [250]);
  assert.equal(isAnimatedPng(apng), false);
});

test("default image without a preceding fcTL is not an animation frame", () => {
  const fallback = fill(2, 2, () => [255, 0, 0, 255]);
  const frame = fill(2, 2, () => [0, 0, 255, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(2, 2, 8, 6) },
    { type: "acTL", data: actlData(1, 4) },
    { type: "IDAT", data: zlibRgba(fallback) },
    { type: "fcTL", data: fctlData(0, 2, 2, 0, 0, 10, 100, 0, 0) },
    { type: "fdAT", data: fdatData(1, zlibRgba(frame)) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  const decoded = decodeApng(apng);
  assert.equal(decoded.frames.length, 1);
  const only = decoded.frames[0];
  assert.ok(only !== undefined);
  assert.deepEqual(only.data, frame.data);
  assert.notDeepEqual(only.data, fallback.data);
  assert.equal(decodePng(apng).data[0], 255);
});

test("a small overlay that disappears restores the background", () => {
  const bg = fill(4, 4, () => [10, 20, 30, 255]);
  const overlay = fill(4, 4, (x, y) => (x === 1 && y === 1 ? [255, 0, 0, 255] : [10, 20, 30, 255]));
  const decoded = decodeApng(
    encodeApng([
      { image: bg, delay: 50 },
      { image: overlay, delay: 50 },
      { image: bg, delay: 50 },
    ]),
  );
  assert.equal(decoded.frames.length, 3);
  assert.deepEqual(decoded.frames[0]?.data, bg.data);
  assert.deepEqual(decoded.frames[1]?.data, overlay.data);
  assert.deepEqual(decoded.frames[2]?.data, bg.data);
});

test("decodeApng honors a custom maxPixels budget on the canvas", () => {
  const png = encodePng(fill(8, 8, () => [1, 2, 3, 255]));
  assert.throws(() => decodeApng(png, { maxPixels: 8 }), /maxPixels/);
});

test("encoded APNG contains acTL before IDAT and fcTL before the default image", () => {
  const a = fill(2, 2, () => [9, 9, 9, 255]);
  const b = fill(2, 2, () => [1, 2, 3, 255]);
  const types = parsePngChunks(encodeApng([{ image: a }, { image: b }])).map((c) => c.type);
  const actl = types.indexOf("acTL");
  const fctl = types.indexOf("fcTL");
  const idat = types.indexOf("IDAT");
  assert.ok(actl >= 0 && actl < idat);
  assert.ok(fctl >= 0 && fctl < idat);
  assert.ok(types.includes("fdAT"));
});

test("decodeApng enforces maxPixels on canvas × frameCount before allocating", () => {
  const apng = encodeApng([
    { image: fill(8, 8, () => [10, 20, 30, 255]), delay: 50 },
    { image: fill(8, 8, () => [40, 50, 60, 255]), delay: 50 },
    { image: fill(8, 8, () => [70, 80, 90, 255]), delay: 50 },
  ]);
  assert.throws(
    () => decodeApng(apng, { maxPixels: 64 }),
    /animation of 3 frames × 8×8 exceeds maxPixels \(192 > 64\); raise maxPixels or use decodePng for the first frame/,
  );
  const decoded = decodeApng(apng, { maxPixels: 192 });
  assert.equal(decoded.frames.length, 3);
});

test("acTL num_frames 0 throws", () => {
  const frame0 = fill(1, 1, () => [1, 2, 3, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(1, 1, 8, 6) },
    { type: "acTL", data: actlData(0, 0) },
    { type: "fcTL", data: fctlData(0, 1, 1, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.throws(() => decodeApng(apng), /num_frames must be at least 1/);
});

test("acTL num_frames mismatching fcTL count throws", () => {
  const frame0 = fill(1, 1, () => [1, 2, 3, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(1, 1, 8, 6) },
    { type: "acTL", data: actlData(5, 0) },
    { type: "fcTL", data: fctlData(0, 1, 1, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.throws(() => decodeApng(apng), /does not match fcTL count/);
});

test("oversized fdAT rect throws before compositing", () => {
  const frame0 = fill(4, 4, () => [10, 20, 30, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(4, 4, 8, 6) },
    { type: "acTL", data: actlData(2, 0) },
    { type: "fcTL", data: fctlData(0, 4, 4, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(frame0) },
    { type: "fcTL", data: fctlData(1, 4, 4, 1, 0, 10, 100, 0, 0) },
    { type: "fdAT", data: fdatData(2, zlibRgba(fill(4, 4, () => [1, 2, 3, 255]))) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.throws(() => decodeApng(apng), /outside the canvas/);
});

test("decodeApng applies eXIf orientation to every frame", () => {
  const left = fill(2, 1, (x) => (x === 0 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const right = fill(2, 1, (x) => (x === 0 ? [20, 220, 20, 255] : [220, 220, 20, 255]));
  const apng = encodeApng(
    [
      { image: left, delay: 40 },
      { image: right, delay: 40 },
    ],
    { loop: 1 },
  );
  const chunks = parsePngChunks(apng);
  const withExif: typeof chunks = [];
  for (const chunk of chunks) {
    if (chunk.type === "IHDR") {
      withExif.push(chunk);
      withExif.push({ type: "eXIf", data: buildExifTiff(6) });
      continue;
    }
    withExif.push(chunk);
  }
  const bytes = assemblePng(withExif);
  const applied = decodeApng(bytes);
  assert.equal(applied.width, 1);
  assert.equal(applied.height, 2);
  assert.equal(applied.frames.length, 2);
  assert.deepEqual(pixelAt(applied.frames[0] ?? left, 0, 0), [220, 20, 20, 255]);
  assert.deepEqual(pixelAt(applied.frames[0] ?? left, 0, 1), [20, 20, 220, 255]);
  const ignored = decodeApng(bytes, { orientation: "ignore" });
  assert.equal(ignored.width, 2);
  assert.equal(ignored.height, 1);
  assert.deepEqual(ignored.frames[0]?.data, left.data);
});

test("hand-built APNG blend_op 1 composites over the previous frame", () => {
  const bg = fill(2, 2, () => [10, 20, 30, 255]);
  const overlay = fill(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 128] : [0, 0, 0, 0]));
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(2, 2, 8, 6) },
    { type: "acTL", data: actlData(2, 1) },
    { type: "fcTL", data: fctlData(0, 2, 2, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(bg) },
    { type: "fcTL", data: fctlData(1, 2, 2, 0, 0, 10, 100, 0, 1) },
    { type: "fdAT", data: fdatData(2, zlibRgba(overlay)) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  const decoded = decodeApng(apng);
  const second = decoded.frames[1];
  assert.ok(second !== undefined);
  const [r, g, b, a] = pixelAt(second, 0, 0);
  assert.ok(r > 10 && r < 255, `blended red, got ${r}`);
  assert.equal(g, 10);
  assert.equal(b, 15);
  assert.equal(a, 255);
  assert.deepEqual(pixelAt(second, 1, 1), [10, 20, 30, 255]);
});

test("hand-built APNG dispose_op 2 restores the previous canvas", () => {
  const blue = fill(2, 2, () => [0, 0, 200, 255]);
  const red = fill(2, 2, () => [200, 0, 0, 255]);
  const green = fill(1, 1, () => [0, 200, 0, 255]);
  const apng = assemblePng([
    { type: "IHDR", data: ihdrData(2, 2, 8, 6) },
    { type: "acTL", data: actlData(3, 1) },
    { type: "fcTL", data: fctlData(0, 2, 2, 0, 0, 10, 100, 0, 0) },
    { type: "IDAT", data: zlibRgba(blue) },
    { type: "fcTL", data: fctlData(1, 2, 2, 0, 0, 10, 100, 2, 0) },
    { type: "fdAT", data: fdatData(2, zlibRgba(red)) },
    { type: "fcTL", data: fctlData(3, 1, 1, 0, 0, 10, 100, 0, 0) },
    { type: "fdAT", data: fdatData(4, zlibRgba(green)) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  const decoded = decodeApng(apng);
  assert.equal(decoded.frames.length, 3);
  assert.deepEqual(decoded.frames[0]?.data, blue.data);
  assert.deepEqual(decoded.frames[1]?.data, red.data);
  const restored = decoded.frames[2];
  assert.ok(restored !== undefined);
  assert.deepEqual(pixelAt(restored, 0, 0), [0, 200, 0, 255]);
  assert.deepEqual(pixelAt(restored, 1, 0), [0, 0, 200, 255]);
  assert.deepEqual(pixelAt(restored, 0, 1), [0, 0, 200, 255]);
  assert.deepEqual(pixelAt(restored, 1, 1), [0, 0, 200, 255]);
});

test("APNG whose IDAT is split into 200k one-byte chunks decodes (no spread RangeError)", () => {
  const frame = fill(240, 240, (x, y) => [x & 255, y & 255, (x ^ y) & 255, 255]);
  const stride = 1 + 240 * 4;
  const raw = new Uint8Array(240 * stride);
  for (let y = 0; y < 240; y++) {
    raw.set(frame.data.subarray(y * 240 * 4, (y + 1) * 240 * 4), y * stride + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 0 }));
  assert.ok(idat.length > 200_000);
  const chunks = [
    { type: "IHDR", data: ihdrData(240, 240, 8, 6) },
    { type: "acTL", data: actlData(1, 0) },
    { type: "fcTL", data: fctlData(0, 240, 240, 0, 0, 10, 100, 0, 0) },
  ];
  for (let i = 0; i < idat.length; i++) {
    chunks.push({ type: "IDAT", data: idat.subarray(i, i + 1) });
  }
  chunks.push({ type: "IEND", data: new Uint8Array(0) });
  const decoded = decodeApng(assemblePng(chunks));
  assert.deepEqual(decoded.frames[0]?.data, frame.data);
});
