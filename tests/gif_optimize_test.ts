import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, decodeGif, encodeGif, optimizeGif } from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import { encodeLzw } from "../src/gif/lzw.ts";

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

function totalDelay(delays: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < delays.length; i++) {
    n += delays[i] ?? 0;
  }
  return n;
}

function assertFramesEqual(a: PixelBuffer, b: PixelBuffer, label: string): void {
  assert.equal(a.width, b.width, `${label} width`);
  assert.equal(a.height, b.height, `${label} height`);
  assert.deepEqual(a.data, b.data, `${label} pixels`);
}

function colorTableBits(colorCount: number): number {
  let bits = 1;
  while (1 << bits < colorCount) {
    bits += 1;
  }
  return Math.min(8, Math.max(1, bits));
}

/** Full-canvas independent frames (disposal 2). Used as the naive baseline. */
function encodeNaiveAnimation(
  frames: readonly PixelBuffer[],
  delays: readonly number[],
  loop: number,
): Uint8Array {
  const first = frames[0];
  if (first === undefined) {
    throw new Error("need frames");
  }
  const width = first.width;
  const height = first.height;
  const palette: number[] = [];
  const indexOf = new Map<number, number>();
  let transparentIndex: number | undefined;
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    if (frame === undefined) {
      continue;
    }
    const n = width * height;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const a = frame.data[i + 3] ?? 0;
      if (a < 128) {
        if (transparentIndex === undefined) {
          transparentIndex = palette.length;
          palette.push(0);
        }
        continue;
      }
      const key =
        (((frame.data[i] ?? 0) << 16) |
          ((frame.data[i + 1] ?? 0) << 8) |
          (frame.data[i + 2] ?? 0)) >>>
        0;
      if (!indexOf.has(key)) {
        if (palette.length >= 256) {
          continue;
        }
        indexOf.set(key, palette.length);
        palette.push(key);
      }
    }
  }
  if (palette.length === 0) {
    palette.push(0);
  }
  const bits = colorTableBits(palette.length);
  const tableSize = 1 << bits;
  const rgb = new Uint8Array(tableSize * 3);
  for (let i = 0; i < palette.length && i < tableSize; i++) {
    if (transparentIndex !== undefined && i === transparentIndex) {
      continue;
    }
    const color = palette[i] ?? 0;
    rgb[i * 3] = (color >>> 16) & 0xff;
    rgb[i * 3 + 1] = (color >>> 8) & 0xff;
    rgb[i * 3 + 2] = color & 0xff;
  }

  const out: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  const push16 = (n: number): void => {
    out.push(n & 0xff, (n >>> 8) & 0xff);
  };
  push16(width);
  push16(height);
  out.push(0x80 | ((bits - 1) << 4) | (bits - 1));
  out.push(transparentIndex ?? 0);
  out.push(0);
  for (let i = 0; i < rgb.length; i++) {
    out.push(rgb[i] ?? 0);
  }
  out.push(0x21, 0xff, 11);
  for (const c of "NETSCAPE2.0") {
    out.push(c.charCodeAt(0));
  }
  out.push(3, 1);
  push16(loop);
  out.push(0);

  const minCodeSize = Math.max(2, bits);
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    if (frame === undefined) {
      continue;
    }
    const indexes = new Uint8Array(width * height);
    for (let p = 0; p < indexes.length; p++) {
      const i = p * 4;
      if ((frame.data[i + 3] ?? 0) < 128) {
        indexes[p] = transparentIndex ?? 0;
        continue;
      }
      const key =
        (((frame.data[i] ?? 0) << 16) |
          ((frame.data[i + 1] ?? 0) << 8) |
          (frame.data[i + 2] ?? 0)) >>>
        0;
      indexes[p] = indexOf.get(key) ?? 0;
    }
    const delayMs = delays[f] ?? 100;
    const delayCs = Math.min(65535, Math.max(0, Math.round(delayMs / 10)));
    let packed = (2 & 7) << 2;
    if (transparentIndex !== undefined) {
      packed |= 1;
    }
    out.push(0x21, 0xf9, 0x04, packed);
    push16(delayCs);
    out.push(transparentIndex ?? 0, 0);
    out.push(0x2c);
    push16(0);
    push16(0);
    push16(width);
    push16(height);
    out.push(0);
    out.push(minCodeSize);
    const compressed = encodeLzw(minCodeSize, indexes);
    for (let offset = 0; offset < compressed.length; offset += 255) {
      const size = Math.min(255, compressed.length - offset);
      out.push(size);
      for (let j = 0; j < size; j++) {
        out.push(compressed[offset + j] ?? 0);
      }
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

function movingSpriteFrames(
  count: number,
  canvas: number,
  sprite: number,
  transparentBg: boolean,
): PixelBuffer[] {
  const frames: PixelBuffer[] = [];
  for (let f = 0; f < count; f++) {
    const x0 = Math.min(canvas - sprite, f * 2);
    const y0 = Math.min(canvas - sprite, f);
    frames.push(
      fill(canvas, canvas, (x, y) => {
        if (x >= x0 && x < x0 + sprite && y >= y0 && y < y0 + sprite) {
          return [220, 30, 30, 255];
        }
        if (transparentBg) {
          return [0, 0, 0, 0];
        }
        const i = (x * 13 + y * 17 + 3) % 200;
        return [i, 40, 200 - i, 255];
      }),
    );
  }
  return frames;
}

function fadeFrames(count: number, width: number, height: number): PixelBuffer[] {
  const frames: PixelBuffer[] = [];
  for (let f = 0; f < count; f++) {
    const g = Math.round((f / Math.max(1, count - 1)) * 255);
    frames.push(fill(width, height, () => [g, 16, 255 - g, 255]));
  }
  return frames;
}

test("moving-sprite animation is lossless and several times smaller than naive full frames", () => {
  const frames = movingSpriteFrames(20, 200, 40, false);
  const delays = frames.map(() => 80);
  const naive = encodeNaiveAnimation(frames, delays, 0);
  const optimized = encodeGif(
    frames.map((frame, i) => ({ ...frame, delay: delays[i] ?? 80 })),
    { loop: 0, palette: "local" },
  );
  const decoded = decodeGif(optimized);
  assert.equal(decoded.frames.length, 20);
  assert.deepEqual(decoded.delays, delays);
  assert.equal(decoded.loop, 0);
  for (let i = 0; i < frames.length; i++) {
    const got = decoded.frames[i];
    const want = frames[i];
    assert.ok(got !== undefined);
    assert.ok(want !== undefined);
    assertFramesEqual(got, want, `frame ${i}`);
  }
  assert.ok(
    optimized.length * 3 <= naive.length,
    `expected ≥3× smaller than naive (${optimized.length} vs ${naive.length})`,
  );
});

test("optimizeGif is lossless for synthetic animations and shrinks the moving sprite", () => {
  const cases: {
    readonly name: string;
    readonly frames: PixelBuffer[];
    readonly delays: number[];
    readonly loop: number | undefined;
    readonly minShrink: number;
  }[] = [
    {
      name: "moving sprite",
      frames: movingSpriteFrames(20, 200, 40, false),
      delays: Array.from({ length: 20 }, () => 80),
      loop: 0,
      minShrink: 3,
    },
    {
      name: "fade local palettes",
      frames: fadeFrames(8, 24, 16),
      delays: Array.from({ length: 8 }, () => 120),
      loop: 4,
      minShrink: 0,
    },
    {
      name: "source transparency",
      frames: movingSpriteFrames(6, 48, 12, true),
      delays: Array.from({ length: 6 }, () => 50),
      loop: 0,
      minShrink: 0,
    },
  ];

  for (let c = 0; c < cases.length; c++) {
    const spec = cases[c];
    if (spec === undefined) {
      continue;
    }
    const naive = encodeNaiveAnimation(spec.frames, spec.delays, spec.loop ?? 0);
    const before = decodeGif(naive);
    const result = optimizeGif(naive);
    const after = decodeGif(result.bytes);
    assert.equal(after.width, before.width, spec.name);
    assert.equal(after.height, before.height, spec.name);
    assert.equal(after.loop, before.loop, `${spec.name} loop`);
    assert.equal(totalDelay(after.delays), totalDelay(before.delays), `${spec.name} duration`);
    assert.equal(after.frames.length, before.frames.length, `${spec.name} frame count`);
    for (let i = 0; i < before.frames.length; i++) {
      const got = after.frames[i];
      const want = before.frames[i];
      assert.ok(got !== undefined);
      assert.ok(want !== undefined);
      assertFramesEqual(got, want, `${spec.name} frame ${i}`);
    }
    if (spec.minShrink > 0) {
      assert.equal(result.changed, true, spec.name);
      assert.ok(
        result.bytes.length * spec.minShrink <= naive.length,
        `${spec.name}: ${result.bytes.length} vs naive ${naive.length}`,
      );
    }
  }
});

test("optimizeGif still is lossless and returns a compact input unchanged", () => {
  const image = fill(1, 1, () => [255, 0, 0, 255]);
  const gif = encodeGif(image);
  const result = optimizeGif(gif);
  const decoded = decodeGif(result.bytes);
  assert.equal(decoded.frames.length, 1);
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.deepEqual(frame.data, image.data);
  assert.equal(decoded.loop, undefined);
  assert.equal(result.changed, false);
  assert.equal(result.bytes, gif);
});

test("optimizeGif merges identical consecutive frames but keeps total duration", () => {
  const red = fill(3, 3, () => [200, 0, 0, 255]);
  const blue = fill(3, 3, () => [0, 0, 200, 255]);
  const naive = encodeNaiveAnimation([red, red, red, blue], [100, 100, 100, 200], 0);
  const result = optimizeGif(naive);
  const decoded = decodeGif(result.bytes);
  assert.equal(totalDelay(decoded.delays), 500);
  assert.equal(decoded.frames.length, 2);
  const f0 = decoded.frames[0];
  const f1 = decoded.frames[1];
  assert.ok(f0 !== undefined);
  assert.ok(f1 !== undefined);
  assert.deepEqual(f0.data, red.data);
  assert.deepEqual(f1.data, blue.data);
});

test("optimizeGif passes maxPixels through to a single decode", () => {
  const gif = encodeGif(fill(8, 8, () => [0, 128, 255, 255]));
  assert.throws(() => optimizeGif(gif, { maxPixels: 4 }), /GIF: 8x8 exceeds maxPixels/);
  const ok = optimizeGif(gif, { maxPixels: 64 });
  const decoded = decodeGif(ok.bytes);
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 8);
});
