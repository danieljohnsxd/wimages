import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import { createPixelBuffer, encodePng } from "../dist/index.js";
import type { PixelBuffer, PngEncodeOptions } from "../dist/index.js";
import { decodePngRgba, parsePngChunks, readPngIhdr } from "./png_decode_helper.ts";
import { untyped } from "./untyped.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const FILTER_SUB = 1;

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

function assertRoundtrip(image: PixelBuffer, options?: PngEncodeOptions): Uint8Array {
  const png = encodePng(image, options);
  const decoded = decodePngRgba(png);
  assert.equal(decoded.width, image.width);
  assert.equal(decoded.height, image.height);
  assert.deepEqual(decoded.data, image.data);
  return png;
}

function lastChunkType(png: Uint8Array): string {
  const chunks = parsePngChunks(png);
  const last = chunks[chunks.length - 1];
  assert.ok(last !== undefined, "PNG has no chunks");
  return last.type;
}

function idatZlib(png: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of parsePngChunks(png)) {
    if (chunk.type === "IDAT") {
      parts.push(chunk.data);
    }
  }
  let n = 0;
  for (const p of parts) {
    n += p.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function zlibFlevel(png: Uint8Array): number {
  const idat = idatZlib(png);
  return ((idat[1] ?? 0) >> 6) & 3;
}

function scanlineFilterTypes(png: Uint8Array): number[] {
  const ihdr = readPngIhdr(png);
  const raw = inflateSync(idatZlib(png));
  assert.equal(raw.length % ihdr.height, 0);
  const rowSize = raw.length / ihdr.height;
  const types: number[] = [];
  for (let y = 0; y < ihdr.height; y++) {
    types.push(raw[y * rowSize] ?? -1);
  }
  return types;
}

test("PNG signature is the 8-byte magic", () => {
  const png = encodePng(createPixelBuffer(1, 1));
  assert.deepEqual([...png.subarray(0, 8)], [...PNG_SIGNATURE]);
});

test("IHDR stores width and height; IEND is present", () => {
  const png = encodePng(createPixelBuffer(12, 7));
  const ihdr = readPngIhdr(png);
  assert.equal(ihdr.width, 12);
  assert.equal(ihdr.height, 7);
  assert.equal(lastChunkType(png), "IEND");
  const types = new Set(parsePngChunks(png).map((c) => c.type));
  assert.ok(types.has("IHDR"));
  assert.ok(types.has("IEND"));
});

test("1x1 red opaque pixel roundtrips", () => {
  const image = fillPixels(1, 1, () => [255, 0, 0, 255]);
  assertRoundtrip(image);
});

test("2x2 mixed colors roundtrip", () => {
  const image = fillPixels(2, 2, (x, y) => {
    if (x === 0 && y === 0) {
      return [255, 0, 0, 255];
    }
    if (x === 1 && y === 0) {
      return [0, 255, 0, 255];
    }
    if (x === 0 && y === 1) {
      return [0, 0, 255, 255];
    }
    return [255, 255, 0, 255];
  });
  assertRoundtrip(image);
});

test("32x16 RGB gradient with more than 256 unique colors roundtrips exactly", () => {
  const image = fillPixels(32, 16, (x, y) => [x * 8, y * 16, (x * 7 + y * 13) & 255, 255]);
  const seen = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i] ?? 0;
    const g = image.data[i + 1] ?? 0;
    const b = image.data[i + 2] ?? 0;
    const a = image.data[i + 3] ?? 0;
    seen.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
  }
  assert.ok(seen.size > 256);
  const png = assertRoundtrip(image);
  assert.notEqual(readPngIhdr(png).colorType, 3);
});

test("opaque grayscale 8x8 auto-encodes without RGBA and roundtrips", () => {
  const image = fillPixels(8, 8, (x, y) => {
    const gray = (x * 31 + y * 17) & 255;
    return [gray, gray, gray, 255];
  });
  const png = assertRoundtrip(image);
  assert.notEqual(readPngIhdr(png).colorType, 6);
});

test("1-bit-ish gray (only 0 and 255) roundtrips", () => {
  const image = fillPixels(8, 4, (x, y) => {
    const gray = (x + y) % 2 === 0 ? 0 : 255;
    return [gray, gray, gray, 255];
  });
  assertRoundtrip(image);
});

test("gray plus alpha roundtrips", () => {
  const image = fillPixels(6, 4, (x, y) => {
    const gray = (x * 40 + y * 20) & 255;
    const alpha = x === 0 || y === 3 ? 0 : 255;
    return [gray, gray, gray, alpha];
  });
  assertRoundtrip(image);
});

test("true RGBA with varying alpha roundtrips", () => {
  const image = fillPixels(8, 8, (x, y) => [x * 32, y * 32, 128, (x * 17 + y * 9) & 255]);
  assertRoundtrip(image);
});

test("palette-friendly 16-color image roundtrips", () => {
  const palette: Array<readonly [number, number, number, number]> = [
    [0, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
    [255, 0, 255, 255],
    [0, 255, 255, 255],
    [255, 255, 255, 255],
    [128, 0, 0, 255],
    [0, 128, 0, 255],
    [0, 0, 128, 255],
    [128, 128, 0, 255],
    [128, 0, 128, 255],
    [0, 128, 128, 255],
    [128, 128, 128, 255],
    [64, 64, 192, 255],
  ];
  const image = fillPixels(16, 8, (x, y) => {
    const color = palette[(x + y * 3) % palette.length];
    assert.ok(color !== undefined);
    return color;
  });
  assertRoundtrip(image);
});

test("transparent palette color roundtrips", () => {
  const image = fillPixels(4, 2, (x) => (x % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]));
  assertRoundtrip(image);
});

test("solid 64x64 at default effort is smaller than raw RGBA", () => {
  const image = fillPixels(64, 64, () => [40, 80, 120, 255]);
  const png = encodePng(image);
  assert.ok(png.length < 64 * 64 * 4);
  const decoded = decodePngRgba(png);
  assert.deepEqual(decoded.data, image.data);
});

test("effort fast and strong both roundtrip", () => {
  const image = fillPixels(8, 8, (x, y) => {
    const on = (x + y) % 2 === 0;
    return on ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  assertRoundtrip(image, { effort: "fast" });
  assertRoundtrip(image, { effort: "strong" });
});

test("effort defaults to fast; fast uses sub filter plus level-2-class deflate", () => {
  const image = fillPixels(16, 8, (x, y) => [x * 16, y * 32, 90, 255]);
  const def = encodePng(image);
  assert.deepEqual(def, encodePng(image, { effort: "fast" }));
  assert.notDeepEqual(def, encodePng(image, { effort: "strong" }));
  const fast = encodePng(image, { effort: "fast" });
  assert.ok(scanlineFilterTypes(fast).every((t) => t === FILTER_SUB));
  assert.equal(zlibFlevel(fast), 1);
});

test("effort strong uses adaptive filters and max deflate effort", () => {
  const image = fillPixels(32, 16, (x, y) => [x * 8, y * 16, (x * 7 + y * 13) & 255, 255]);
  const fast = encodePng(image, { effort: "fast" });
  const strong = encodePng(image, { effort: "strong" });
  assertRoundtrip(image, { effort: "strong" });
  const types = scanlineFilterTypes(strong);
  assert.ok(
    types.some((t) => t !== FILTER_SUB),
    `filters=${types.join(",")}`,
  );
  assert.equal(zlibFlevel(strong), 3);
  assert.ok(strong.length < fast.length, `strong=${strong.length} fast=${fast.length}`);
});

test("encodePng is deterministic", () => {
  const image = fillPixels(10, 6, (x, y) => [x * 20, y * 30, 64, 255]);
  const a = encodePng(image, { effort: "fast" });
  const b = encodePng(image, { effort: "fast" });
  assert.deepEqual(a, b);
});

test("rejects invalid dimensions", () => {
  assert.throws(() => encodePng({ width: 0, height: 1, data: new Uint8Array(0) }), RangeError);
  assert.throws(() => encodePng({ width: 1, height: 0, data: new Uint8Array(0) }), RangeError);
  assert.throws(() => encodePng({ width: -3, height: 1, data: new Uint8Array(0) }), RangeError);
  assert.throws(() => encodePng({ width: 1.5, height: 1, data: new Uint8Array(6) }), RangeError);
});

test("rejects mismatched RGBA length", () => {
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(4) }), RangeError);
  assert.throws(() => encodePng({ width: 1, height: 1, data: new Uint8Array(3) }), RangeError);
});

test("rejects bad effort", () => {
  const image = createPixelBuffer(1, 1);
  assert.throws(() => encodePng(image, { effort: untyped("slow") }), RangeError);
  assert.throws(() => encodePng(image, { effort: untyped("9") }), RangeError);
});

test("rejects forcing gray on a color image", () => {
  const image = fillPixels(1, 1, () => [255, 0, 0, 255]);
  assert.throws(() => encodePng(image, { colorType: "gray" }), RangeError);
});

test("auto encodes 64x64 256-gray as color type 0, smaller than palette", () => {
  const image = fillPixels(64, 64, (x, y) => {
    const gray = (y * 64 + x) & 255;
    return [gray, gray, gray, 255];
  });
  const autoPng = encodePng(image);
  const palettePng = encodePng(image, { colorType: "palette" });
  const ihdr = readPngIhdr(autoPng);
  assert.equal(ihdr.colorType, 0);
  assert.equal(ihdr.bitDepth, 8);
  assert.ok(autoPng.length < palettePng.length);
  assertRoundtrip(image);
});

test("auto encodes 2-color gray as 1-bit gray", () => {
  const image = fillPixels(16, 8, (x, y) => {
    const gray = (x + y) % 2 === 0 ? 0 : 255;
    return [gray, gray, gray, 255];
  });
  const png = assertRoundtrip(image);
  const ihdr = readPngIhdr(png);
  assert.equal(ihdr.bitDepth, 1);
  assert.equal(ihdr.colorType, 0);
});

test("encodePng IDAT inflates with node:zlib at both efforts and all color types", () => {
  const noise = fillPixels(16, 16, (x, y) => [
    (x * 37 + y * 19) & 255,
    (x * 11 + y * 53) & 255,
    (x * 7 + y * 29) & 255,
    255,
  ]);
  const alpha = fillPixels(12, 8, (x, y) => [x * 20, y * 30, 90, (x * 17 + y * 9) & 255]);
  const palette = fillPixels(8, 8, (x, y) => {
    const on = (x + y) % 2 === 0;
    return on ? [200, 10, 10, 255] : [10, 10, 200, 0];
  });
  const gray = fillPixels(8, 8, (x, y) => {
    const g = (x * 31 + y * 17) & 255;
    return [g, g, g, 255];
  });
  const grayAlpha = fillPixels(8, 4, (x, y) => {
    const g = (x * 40 + y * 20) & 255;
    return [g, g, g, x === 0 ? 0 : 255];
  });

  const cases: Array<{
    readonly name: string;
    readonly image: PixelBuffer;
    readonly colorType: NonNullable<PngEncodeOptions["colorType"]>;
  }> = [
    { name: "noise-rgb", image: noise, colorType: "rgb" },
    { name: "noise-rgba", image: noise, colorType: "rgba" },
    { name: "alpha-rgba", image: alpha, colorType: "rgba" },
    { name: "alpha-gray-alpha", image: grayAlpha, colorType: "gray-alpha" },
    { name: "palette", image: palette, colorType: "palette" },
    { name: "gray", image: gray, colorType: "gray" },
  ];

  for (const effort of ["fast", "strong"] as const) {
    for (const c of cases) {
      const png = encodePng(c.image, { effort, colorType: c.colorType });
      const inflated = inflateSync(idatZlib(png));
      assert.ok(
        inflated.length > 0,
        `${c.name} ${effort}: node:zlib inflated ${inflated.length} bytes`,
      );
      const decoded = decodePngRgba(png);
      assert.deepEqual(decoded.data, c.image.data, `${c.name} ${effort} pixels`);
    }
  }
});
