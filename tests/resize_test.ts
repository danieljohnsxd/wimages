import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, fitSize, resize } from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import { untyped } from "./untyped.ts";

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

function getPixel(
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

function fillSolid(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number,
): PixelBuffer {
  const image = createPixelBuffer(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      setPixel(image, x, y, r, g, b, a);
    }
  }
  return image;
}

test("identity: same size returns the same object when upscale is false", () => {
  const image = fillSolid(8, 6, 10, 20, 30, 255);
  const sameMax = resize(image, { maxSide: 8 });
  assert.equal(sameMax, image);
  const sameExact = resize(image, { width: 8, height: 6 });
  assert.equal(sameExact, image);
  const smallerBound = resize(image, { maxSide: 64 });
  assert.equal(smallerBound, image);
});

test("fitSize math", () => {
  assert.deepEqual(fitSize(4000, 3000, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitSize(3000, 4000, 2048), { width: 1536, height: 2048 });
  assert.deepEqual(fitSize(100, 50, 200), { width: 100, height: 50 });
  assert.deepEqual(fitSize(1, 1, 10), { width: 1, height: 1 });
});

test("solid color stays exactly solid at any ratio", () => {
  const colors: Array<readonly [number, number, number, number]> = [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [17, 64, 200, 255],
    [128, 0, 255, 90],
  ];
  const sizes: Array<readonly [number, number, number, number]> = [
    [5, 5, 3, 3],
    [8, 4, 2, 1],
    [7, 9, 11, 13],
    [3, 8, 16, 5],
  ];
  for (const [r, g, b, a] of colors) {
    for (const [sw, sh, dw, dh] of sizes) {
      const src = fillSolid(sw, sh, r, g, b, a);
      const out = resize(src, { width: dw, height: dh, upscale: true, filter: "lanczos3" });
      assert.equal(out.width, dw);
      assert.equal(out.height, dh);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          assert.deepEqual(
            getPixel(out, x, y),
            [r, g, b, a],
            `${sw}x${sh}->${dw}x${dh} @${x},${y}`,
          );
        }
      }
      const boxed = resize(src, { width: dw, height: dh, upscale: true, filter: "box" });
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          assert.deepEqual(getPixel(boxed, x, y), [r, g, b, a]);
        }
      }
    }
  }
});

test("2× box downscale of a checkerboard is exactly the mean", () => {
  const src = createPixelBuffer(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = ((x + y) & 1) === 0 ? 0 : 255;
      setPixel(src, x, y, v, v, v, 255);
    }
  }
  const out = resize(src, { width: 4, height: 4, filter: "box" });
  assert.equal(out.width, 4);
  assert.equal(out.height, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      assert.deepEqual(getPixel(out, x, y), [128, 128, 128, 255]);
    }
  }
});

test("Lanczos of a horizontal gradient stays monotonic and within ±2 of analytic", () => {
  const srcW = 400;
  const srcH = 6;
  const dstW = 160;
  const src = createPixelBuffer(srcW, srcH);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const v = Math.round((255 * x) / (srcW - 1));
      setPixel(src, x, y, v, 0, 0, 255);
    }
  }
  const out = resize(src, { width: dstW, height: srcH, filter: "lanczos3" });
  assert.equal(out.width, dstW);
  assert.equal(out.height, srcH);
  for (let y = 0; y < srcH; y++) {
    let prev = -1;
    for (let x = 0; x < dstW; x++) {
      const [r, g, b, a] = getPixel(out, x, y);
      assert.equal(g, 0);
      assert.equal(b, 0);
      assert.equal(a, 255);
      assert.ok(r >= prev, `monotonic at ${x},${y}: ${r} < ${prev}`);
      prev = r;
      const t = (x + 0.5) * (srcW / dstW) - 0.5;
      const analytic = (255 * t) / (srcW - 1);
      assert.ok(Math.abs(r - analytic) <= 2, `x=${x} r=${r} analytic=${analytic}`);
    }
  }
});

test("transparent-black + opaque-white checkerboard halves to white at alpha 128", () => {
  const src = createPixelBuffer(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (((x + y) & 1) === 0) {
        setPixel(src, x, y, 255, 255, 255, 255);
      } else {
        setPixel(src, x, y, 0, 0, 0, 0);
      }
    }
  }
  const out = resize(src, { width: 2, height: 2, filter: "box" });
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const [r, g, b, a] = getPixel(out, x, y);
      assert.equal(a, 128, "alpha is the mean");
      assert.equal(r, 255, "no dark fringe on red");
      assert.equal(g, 255, "no dark fringe on green");
      assert.equal(b, 255, "no dark fringe on blue");
    }
  }
});

test("alpha-opaque input yields alpha 255 everywhere", () => {
  const src = createPixelBuffer(9, 7);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 9; x++) {
      setPixel(src, x, y, (x * 13) & 255, (y * 29) & 255, 40, 255);
    }
  }
  const out = resize(src, { width: 3, height: 11, upscale: true, filter: "lanczos3" });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      assert.equal(getPixel(out, x, y)[3], 255);
    }
  }
});

test("maxSide downscales and optionally upscales", () => {
  const src = fillSolid(400, 300, 9, 8, 7, 255);
  const down = resize(src, { maxSide: 200 });
  assert.equal(down.width, 200);
  assert.equal(down.height, 150);
  assert.notEqual(down, src);
  const noUp = resize(src, { maxSide: 800 });
  assert.equal(noUp, src);
  const up = resize(src, { maxSide: 800, upscale: true });
  assert.equal(up.width, 800);
  assert.equal(up.height, 600);
});

test("rejects invalid options", () => {
  const src = fillSolid(2, 2, 1, 2, 3, 255);
  assert.throws(() => resize(src, {}), RangeError);
  assert.throws(() => resize(src, { maxSide: 0 }), RangeError);
  assert.throws(() => resize(src, { maxSide: 1.5 }), RangeError);
  assert.throws(() => resize(src, { width: 4 }), RangeError);
  assert.throws(() => resize(src, { height: 4 }), RangeError);
  assert.throws(() => resize(src, { width: 4, height: 4, maxSide: 4 }), RangeError);
  assert.throws(() => resize(src, { width: 0, height: 4 }), RangeError);
  assert.throws(() => fitSize(0, 1, 1), RangeError);
  assert.throws(() => resize(src, { width: 2, height: 2, filter: untyped("nearest") }), RangeError);
});

test("4000×3000 fits 2048 on the long side", () => {
  const src = createPixelBuffer(4000, 3000);
  src.data.fill(180);
  for (let i = 3; i < src.data.length; i += 4) {
    src.data[i] = 255;
  }
  const out = resize(src, { maxSide: 2048, filter: "lanczos3" });
  assert.equal(out.width, 2048);
  assert.equal(out.height, 1536);
  assert.deepEqual(getPixel(out, 0, 0), [180, 180, 180, 255]);
  assert.deepEqual(getPixel(out, 2047, 1535), [180, 180, 180, 255]);
});
