import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { createPixelBuffer, decodePng, encodePng } from "../dist/index.js";
import {
  assemblePng,
  parsePngChunks,
  readPngIhdr,
  writeIndependentPng,
  writeUint32BE,
} from "./png_decode_helper.ts";
import { untyped } from "./untyped.ts";

function fill(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
) {
  const image = createPixelBuffer(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = a;
    }
  }
  return image;
}

test("decodePng inverts encodePng without node:zlib", () => {
  const image = fill(12, 9, (x, y) => [x * 20, y * 25, 90, 255]);
  const png = encodePng(image);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 12);
  assert.equal(decoded.height, 9);
  assert.deepEqual(decoded.data, image.data);
});

test("decodePng rejects a bad signature", () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4])), /signature/);
});

test("decodePng reads palette + tRNS from our encoder", () => {
  const image = fill(4, 2, (x, y) => (x + y === 0 ? [10, 20, 30, 0] : [200, 10, 10, 255]));
  const png = encodePng(image, { colorType: "palette" });
  assert.equal(readPngIhdr(png).colorType, 3);
  assert.deepEqual(decodePng(png).data, image.data);
});

test("maxColors quantizes then shares the palette encode path", () => {
  const image = fill(32, 16, (x, y) => [x * 8, y * 16, (x * 7 + y * 13) & 255, 255]);
  const lossy = encodePng(image, { maxColors: 16 });
  assert.equal(readPngIhdr(lossy).colorType, 3);

  const decoded = decodePng(lossy);
  const seen = new Set<number>();
  for (let i = 0; i < decoded.data.length; i += 4) {
    const r = decoded.data[i] ?? 0;
    const g = decoded.data[i + 1] ?? 0;
    const b = decoded.data[i + 2] ?? 0;
    const a = decoded.data[i + 3] ?? 0;
    seen.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
  }
  assert.ok(seen.size <= 16);
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 16);
});

test("maxColors is lossless when the image already has few colors", () => {
  const image = fill(8, 8, (x, y) => (((x + y) & 1) === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const png = encodePng(image, { maxColors: 16 });
  assert.deepEqual(decodePng(png).data, image.data);
});

test("rejects maxColors outside 2–256", () => {
  const image = createPixelBuffer(1, 1);
  assert.throws(() => encodePng(image, { maxColors: 1 }), RangeError);
  assert.throws(() => encodePng(image, { maxColors: 257 }), RangeError);
});

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function corruptChunkCrc(png: Uint8Array, type: string): Uint8Array {
  const out = Uint8Array.from(png);
  let offset = 8;
  while (offset + 8 <= out.length) {
    const length =
      ((out[offset] ?? 0) << 24) |
      ((out[offset + 1] ?? 0) << 16) |
      ((out[offset + 2] ?? 0) << 8) |
      (out[offset + 3] ?? 0);
    const t = String.fromCharCode(
      out[offset + 4] ?? 0,
      out[offset + 5] ?? 0,
      out[offset + 6] ?? 0,
      out[offset + 7] ?? 0,
    );
    const crcOffset = offset + 8 + length;
    if (crcOffset + 4 > out.length) {
      throw new RangeError("truncated PNG chunk");
    }
    if (t === type) {
      const b = out[crcOffset];
      if (b === undefined) {
        throw new RangeError("truncated PNG chunk");
      }
      out[crcOffset] = b ^ 0xff;
      return out;
    }
    offset = crcOffset + 4;
  }
  throw new Error(`no ${type} chunk to corrupt`);
}

function dropLastChunk(png: Uint8Array): Uint8Array {
  let offset = 8;
  let lastStart = 8;
  while (offset + 8 <= png.length) {
    const length =
      ((png[offset] ?? 0) << 24) |
      ((png[offset + 1] ?? 0) << 16) |
      ((png[offset + 2] ?? 0) << 8) |
      (png[offset + 3] ?? 0);
    const next = offset + 12 + length;
    if (next > png.length) {
      throw new RangeError("truncated PNG chunk");
    }
    lastStart = offset;
    offset = next;
  }
  return png.subarray(0, lastStart);
}

function ihdrData(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const data = new Uint8Array(13);
  writeUint32BE(data, 0, width);
  writeUint32BE(data, 4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  return data;
}

test("decodePng skips a tEXt chunk with a bad CRC", () => {
  const image = fill(8, 6, (x, y) => [x * 30, y * 40, 80, 255]);
  const png = encodePng(image);
  const chunks = parsePngChunks(png);
  const withText: typeof chunks = [];
  for (const chunk of chunks) {
    if (chunk.type === "IEND") {
      withText.push({
        type: "tEXt",
        data: new Uint8Array([67, 111, 109, 109, 101, 110, 116, 0, 104, 105]),
      });
    }
    withText.push(chunk);
  }
  const corrupted = corruptChunkCrc(assemblePng(withText), "tEXt");
  const decoded = decodePng(corrupted);
  assert.deepEqual(decoded.data, image.data);
});

test("decodePng still throws on a bad IDAT CRC", () => {
  const image = fill(3, 2, (x, y) => [x * 10, y * 20, 30, 255]);
  const png = encodePng(image);
  const corrupted = corruptChunkCrc(png, "IDAT");
  assert.throws(() => decodePng(corrupted), /bad CRC for IDAT/);
});

test("decodePng treats a bad tRNS CRC as absent tRNS", () => {
  const image = fill(4, 2, (x) => (x % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]));
  const png = encodePng(image, { colorType: "palette" });
  assert.ok(parsePngChunks(png).some((c) => c.type === "tRNS"));
  const corrupted = corruptChunkCrc(png, "tRNS");
  const decoded = decodePng(corrupted);
  for (let i = 3; i < decoded.data.length; i += 4) {
    assert.equal(decoded.data[i], 255);
  }
});

test("decodePng ignores trailing bytes after IEND", () => {
  const image = fill(5, 4, (x, y) => [x * 40, y * 50, 90, 255]);
  const png = encodePng(image);
  const withJunk = concatBytes([png, new Uint8Array([1, 2, 3, 4, 5, 255, 0, 0])]);
  const decoded = decodePng(withJunk);
  assert.deepEqual(decoded.data, image.data);
});

test("decodePng throws a clear error when IEND is missing", () => {
  const image = fill(2, 2, (x, y) => [x * 80, y * 90, 10, 255]);
  const png = encodePng(image);
  const truncated = dropLastChunk(png);
  assert.throws(() => decodePng(truncated), /missing IEND/);
});

test("decodePng rejects IHDR dimensions above maxPixels without allocating", () => {
  const png = assemblePng([
    { type: "IHDR", data: ihdrData(65535, 65535, 8, 0) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  const start = Date.now();
  assert.throws(() => decodePng(png), /maxPixels/);
  assert.ok(Date.now() - start < 1000);
});

test("decodePng rejects a custom maxPixels budget", () => {
  const image = fill(4, 4, () => [10, 20, 30, 255]);
  const png = encodePng(image);
  assert.throws(() => decodePng(png, { maxPixels: 4 }), /maxPixels/);
});

test("decodePng throws when IDAT inflates past the expected scanline size", () => {
  const bomb = new Uint8Array(deflateSync(new Uint8Array(1_000_000)));
  const png = assemblePng([
    { type: "IHDR", data: ihdrData(1, 1, 8, 6) },
    { type: "IDAT", data: bomb },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.throws(() => decodePng(png), /maxOutput|exceeds/);
});

test("decodePng rejects a bad IHDR CRC", () => {
  const png = encodePng(fill(2, 2, () => [10, 20, 30, 255]));
  assert.throws(() => decodePng(corruptChunkCrc(png, "IHDR")), /bad CRC for IHDR/);
});

test("decodePng rejects a bad PLTE CRC and a bad IEND CRC", () => {
  const png = encodePng(
    fill(4, 2, (x) => (x % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255])),
    { colorType: "palette" },
  );
  assert.throws(() => decodePng(corruptChunkCrc(png, "PLTE")), /bad CRC for PLTE/);
  assert.throws(() => decodePng(corruptChunkCrc(png, "IEND")), /bad CRC for IEND/);
});

function fourColorRgba(): Uint8Array {
  return new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
}

test("decodePng reads an independent Adam7 2×2 RGB PNG", () => {
  const rgba = fourColorRgba();
  const png = writeIndependentPng({
    width: 2,
    height: 2,
    colorType: 2,
    interlace: 1,
    filter: 0,
    rgba,
  });
  const decoded = decodePng(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual(decoded.data, rgba);
});

test("decodePng reads an independent Paeth-filtered RGB PNG", () => {
  const rgba = fourColorRgba();
  const png = writeIndependentPng({
    width: 2,
    height: 2,
    colorType: 2,
    filter: 4,
    rgba,
  });
  assert.deepEqual(decodePng(png).data, rgba);
});

test("decodePng reads an independent paletted+tRNS PNG", () => {
  const png = writeIndependentPng({
    width: 2,
    height: 1,
    colorType: 3,
    rgba: new Uint8Array([0, 0, 0, 255, 1, 0, 0, 255]),
    plte: new Uint8Array([255, 0, 0, 0, 0, 255]),
    trns: new Uint8Array([255, 0]),
  });
  assert.deepEqual(decodePng(png).data, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0]));
});

test("decodePng reads a 16-bit gray 0x1234 as high byte 0x12", () => {
  const png = assemblePng([
    { type: "IHDR", data: ihdrData(1, 1, 16, 0) },
    { type: "IDAT", data: new Uint8Array(deflateSync(new Uint8Array([0, 0x12, 0x34]))) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
  assert.deepEqual(decodePng(png).data, new Uint8Array([0x12, 0x12, 0x12, 255]));
});

test("decodePng 16-bit RGB/RGBA high-byte round trip is exact", () => {
  const rgb = new Uint8Array([0x12, 0x56, 0x9a, 255, 0x00, 0x80, 0xff, 255]);
  const rgbPng = writeIndependentPng({
    width: 2,
    height: 1,
    colorType: 2,
    bitDepth: 16,
    rgba: rgb,
  });
  assert.deepEqual(decodePng(rgbPng).data, rgb);

  const rgba = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
  const rgbaPng = writeIndependentPng({
    width: 2,
    height: 1,
    colorType: 6,
    bitDepth: 16,
    rgba,
  });
  assert.deepEqual(decodePng(rgbaPng).data, rgba);
});

test("16-bit encode→decode via the independent writer is exact", () => {
  const rgba = fill(3, 2, (x, y) => [x * 40, y * 80, 200, 255]).data;
  const png = writeIndependentPng({
    width: 3,
    height: 2,
    colorType: 2,
    bitDepth: 16,
    rgba,
  });
  assert.deepEqual(decodePng(png).data, rgba);
});

test("decodePng reads gray and RGB chroma-key tRNS", () => {
  const gray = writeIndependentPng({
    width: 2,
    height: 1,
    colorType: 0,
    rgba: new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255]),
    trns: new Uint8Array([0, 10]),
  });
  assert.deepEqual(decodePng(gray).data, new Uint8Array([10, 10, 10, 0, 20, 20, 20, 255]));

  const rgb = writeIndependentPng({
    width: 2,
    height: 1,
    colorType: 2,
    rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
    trns: new Uint8Array([0, 1, 0, 2, 0, 3]),
  });
  assert.deepEqual(decodePng(rgb).data, new Uint8Array([1, 2, 3, 0, 4, 5, 6, 255]));
});

test("16-bit PNG counts the scanline buffer against maxPixels", () => {
  const png = writeIndependentPng({
    width: 2,
    height: 2,
    colorType: 6,
    bitDepth: 16,
    rgba: fourColorRgba(),
  });
  assert.throws(() => decodePng(png, { maxPixels: 4 }), /16-bit exceeds maxPixels/);
  const decoded = decodePng(png, { maxPixels: 32 });
  assert.equal(decoded.width, 2);
});

test("decodePng rejects an invalid orientation option", () => {
  const png = encodePng(fill(1, 1, () => [1, 2, 3, 255]));
  assert.throws(() => decodePng(png, { orientation: untyped("rotate") }), /orientation must be/);
});
