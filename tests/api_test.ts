import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, encodeJpeg, encodePng } from "../dist/index.js";
import * as gifEntry from "../dist/gif.js";
import * as jpegEntry from "../dist/jpeg.js";
import * as pngEntry from "../dist/png.js";
import * as resizeEntry from "../dist/resize.js";

test("createPixelBuffer allocates packed RGBA", () => {
  const buf = createPixelBuffer(2, 3);
  assert.equal(buf.width, 2);
  assert.equal(buf.height, 3);
  assert.equal(buf.data.length, 2 * 3 * 4);
  assert.ok(buf.data.every((b) => b === 0));
});

test("createPixelBuffer rejects non-positive sizes", () => {
  assert.throws(() => createPixelBuffer(0, 1), RangeError);
  assert.throws(() => createPixelBuffer(1, 0), RangeError);
  assert.throws(() => createPixelBuffer(-1, 1), RangeError);
  assert.throws(() => createPixelBuffer(1.5, 1), RangeError);
});

test("encode presets are accepted", () => {
  const buf = createPixelBuffer(2, 2);
  buf.data.fill(255);
  const png = encodePng(buf, { effort: "fast" });
  const jpg = encodeJpeg(buf, { quality: "balanced" });
  assert.ok(png.length > 8);
  assert.ok(jpg.length > 2);
});

function assertExports(mod: object, names: readonly string[], label: string): void {
  for (const name of names) {
    assert.equal(typeof Reflect.get(mod, name), "function", `${label} exports ${name}`);
  }
}

test("png subpath exports the PNG codec surface", () => {
  assertExports(
    pngEntry,
    [
      "createPixelBuffer",
      "decodePng",
      "encodePng",
      "quantizeToPalette",
      "readImageMetadata",
      "withExifOrientation",
      "exifOrientation",
      "decodeApng",
      "encodeApng",
      "isAnimatedPng",
    ],
    "png",
  );
});

test("jpeg subpath exports the JPEG codec surface", () => {
  assertExports(
    jpegEntry,
    [
      "createPixelBuffer",
      "decodeJpeg",
      "encodeJpeg",
      "readImageMetadata",
      "withExifOrientation",
      "exifOrientation",
      "transcodeJpeg",
    ],
    "jpeg",
  );
});

test("gif subpath exports the GIF codec surface", () => {
  assertExports(gifEntry, ["createPixelBuffer", "decodeGif", "encodeGif", "optimizeGif"], "gif");
});

test("resize subpath exports fitSize and resize", () => {
  assertExports(resizeEntry, ["createPixelBuffer", "fitSize", "resize"], "resize");
});
