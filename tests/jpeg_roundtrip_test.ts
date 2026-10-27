import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeGif, decodeJpeg, encodeJpeg, type PixelBuffer } from "../dist/index.js";

function photo(width: number, height: number): PixelBuffer {
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed >>> 26) & 7;
      const i = (y * width + x) * 4;
      data[i] = ((x * 255) / width + noise) & 255;
      data[i + 1] = ((y * 255) / height + noise) & 255;
      data[i + 2] = (128 + 100 * Math.sin(x / 7) * Math.cos(y / 5) + noise) & 255;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function mae(a: PixelBuffer, b: PixelBuffer): number {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i++) {
    if ((i & 3) === 3) continue;
    sum += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    n++;
  }
  return sum / n;
}

const src = photo(53, 41);

test("progressive output decodes to the same pixels as baseline output", () => {
  for (const chroma of ["4:2:0", "4:2:2", "4:4:4"] as const) {
    const baseline = decodeJpeg(encodeJpeg(src, { quality: 80, chroma }));
    const progressive = decodeJpeg(encodeJpeg(src, { quality: 80, chroma, progressive: true }));
    // Same quantized coefficients, different entropy coding: only the IDCT rounding path differs.
    assert.ok(mae(baseline, progressive) < 0.05, `${chroma}: mae=${mae(baseline, progressive)}`);
    assert.ok(mae(baseline, src) < 6, `${chroma}: quality drift mae=${mae(baseline, src)}`);
  }
});

test("quality 80 numeric matches the balanced preset byte-for-byte", () => {
  const numeric = encodeJpeg(src, { quality: 80 });
  const balanced = encodeJpeg(src, { quality: "balanced" });
  const def = encodeJpeg(src);
  assert.deepEqual(numeric, balanced);
  assert.deepEqual(def, balanced);
});

test("maxPixels is width × height for JPEG, like every other decoder", () => {
  const jpeg = encodeJpeg(src, { quality: 50, chroma: "4:2:0" });
  assert.throws(() => decodeJpeg(jpeg, { maxPixels: 100 }), /JPEG:.*maxPixels/);
  assert.throws(() => decodeJpeg(jpeg, { maxPixels: 53 * 41 - 1 }), /JPEG:.*maxPixels/);
  // 53×41 4:2:0 pads to 64×48 plus chroma planes; only the image pixels count.
  assert.equal(decodeJpeg(jpeg, { maxPixels: 53 * 41 }).width, 53);
  const gif = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x3b,
  ]);
  assert.throws(() => decodeGif(gif, { maxPixels: 1_000_000 }), /maxPixels/);
});
