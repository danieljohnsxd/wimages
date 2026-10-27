import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, decodeGif, encodeGif } from "../dist/index.js";
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

function push16(out: number[], n: number): void {
  out.push(n & 0xff, (n >>> 8) & 0xff);
}

function writeSubBlocks(out: number[], data: Uint8Array): void {
  for (let offset = 0; offset < data.length; offset += 255) {
    const size = Math.min(255, data.length - offset);
    out.push(size);
    for (let i = 0; i < size; i++) {
      out.push(data[offset + i] ?? 0);
    }
  }
  out.push(0);
}

function colorTableBits(colorCount: number): number {
  let bits = 1;
  while (1 << bits < colorCount) {
    bits += 1;
  }
  return Math.min(8, Math.max(1, bits));
}

type CraftFrame = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly indexes: Uint8Array;
  /** Graphic-control delay in centiseconds (file units). */
  readonly delayCs: number;
  readonly disposal: number;
  readonly transparentIndex: number | undefined;
  readonly interlace?: boolean;
};

/** Hand-built GIF with an explicit logical screen, GCT, and image descriptors. */
function craftGif(options: {
  readonly width: number;
  readonly height: number;
  readonly gct: Uint8Array;
  readonly loop?: number;
  readonly frames: readonly CraftFrame[];
}): Uint8Array {
  const colorCount = (options.gct.length / 3) | 0;
  const bits = colorTableBits(Math.max(2, colorCount));
  const out: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  push16(out, options.width);
  push16(out, options.height);
  out.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < options.gct.length; i++) {
    out.push(options.gct[i] ?? 0);
  }
  const tableSize = (1 << bits) * 3;
  for (let i = options.gct.length; i < tableSize; i++) {
    out.push(0);
  }
  if (options.loop !== undefined) {
    out.push(0x21, 0xff, 11);
    for (const c of "NETSCAPE2.0") {
      out.push(c.charCodeAt(0));
    }
    out.push(3, 1);
    push16(out, options.loop);
    out.push(0);
  }
  const minCodeSize = Math.max(2, bits);
  for (let i = 0; i < options.frames.length; i++) {
    const frame = options.frames[i];
    if (frame === undefined) {
      continue;
    }
    let packed = (frame.disposal & 7) << 2;
    if (frame.transparentIndex !== undefined) {
      packed |= 1;
    }
    out.push(0x21, 0xf9, 0x04, packed);
    push16(out, frame.delayCs);
    out.push(frame.transparentIndex ?? 0, 0);
    out.push(0x2c);
    push16(out, frame.left);
    push16(out, frame.top);
    push16(out, frame.width);
    push16(out, frame.height);
    out.push(frame.interlace === true ? 0x40 : 0);
    out.push(minCodeSize);
    writeSubBlocks(out, encodeLzw(minCodeSize, frame.indexes));
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

function craft2x2(frames: readonly CraftFrame[]): Uint8Array {
  return craftGif({
    width: 2,
    height: 2,
    gct: new Uint8Array([255, 0, 0, 0, 0, 255]),
    loop: 0,
    frames,
  });
}

test("decoder composites a partial frame with disposal 1 (leave)", () => {
  const gif = craft2x2([
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([0, 0, 0, 0]),
      delayCs: 10,
      disposal: 1,
      transparentIndex: undefined,
    },
    {
      left: 1,
      top: 1,
      width: 1,
      height: 1,
      indexes: new Uint8Array([1]),
      delayCs: 20,
      disposal: 1,
      transparentIndex: undefined,
    },
  ]);
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 2);
  const f0 = decoded.frames[0];
  const f1 = decoded.frames[1];
  assert.ok(f0 !== undefined);
  assert.ok(f1 !== undefined);
  assert.deepEqual(pixelAt(f0, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 0, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 1, 1), [0, 0, 255, 255]);
  assert.deepEqual(decoded.delays, [100, 200]);
});

test("decoder disposal 2 clears only the frame rectangle", () => {
  const gif = craft2x2([
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([0, 0, 0, 0]),
      delayCs: 5,
      disposal: 2,
      transparentIndex: undefined,
    },
    {
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      indexes: new Uint8Array([1]),
      delayCs: 5,
      disposal: 1,
      transparentIndex: undefined,
    },
  ]);
  const decoded = decodeGif(gif);
  const f1 = decoded.frames[1];
  assert.ok(f1 !== undefined);
  assert.deepEqual(pixelAt(f1, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixelAt(f1, 1, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(f1, 0, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(f1, 1, 1), [0, 0, 0, 0]);
});

test("decoder skip-draws the transparent index over the previous canvas", () => {
  const gif = craft2x2([
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([0, 0, 0, 0]),
      delayCs: 1,
      disposal: 1,
      transparentIndex: undefined,
    },
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([1, 1, 1, 0]),
      delayCs: 1,
      disposal: 1,
      transparentIndex: 1,
    },
  ]);
  const decoded = decodeGif(gif);
  const f1 = decoded.frames[1];
  assert.ok(f1 !== undefined);
  assert.deepEqual(pixelAt(f1, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 0, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 1, 1), [255, 0, 0, 255]);
});

test("decoder applies per-frame local color tables and transparency", () => {
  const frameA = fill(4, 1, (x) => [x * 40, 0, 0, 255]);
  const frameB = fill(4, 1, (x) => (x === 1 ? [0, 0, 0, 0] : [0, x * 50, 255, 255]));
  const decoded = decodeGif(encodeGif([frameA, frameB], { palette: "local" }));
  assert.equal(decoded.frames.length, 2);
  const outA = decoded.frames[0];
  const outB = decoded.frames[1];
  assert.ok(outA !== undefined);
  assert.ok(outB !== undefined);
  assert.deepEqual(outA.data, frameA.data);
  assert.equal(pixelAt(outB, 1, 0)[3], 0);
  for (const x of [0, 2, 3]) {
    const [r, g, b, a] = pixelAt(outB, x, 0);
    assert.equal(r, 0);
    assert.equal(g, x * 50);
    assert.equal(b, 255);
    assert.equal(a, 255);
  }
});

test("decoder reports delay 0 as 0 ms and other delays as centiseconds × 10", () => {
  const gif = craft2x2([
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([0, 0, 0, 0]),
      delayCs: 0,
      disposal: 1,
      transparentIndex: undefined,
    },
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([1, 1, 1, 1]),
      delayCs: 7,
      disposal: 1,
      transparentIndex: undefined,
    },
  ]);
  const decoded = decodeGif(gif);
  assert.deepEqual(decoded.delays, [0, 70]);
});

test("interlaced 1×8 still deinterleaves to a known pixel map", () => {
  const gct = new Uint8Array(8 * 3);
  for (let i = 0; i < 8; i++) {
    gct[i * 3] = i;
    gct[i * 3 + 1] = i;
    gct[i * 3 + 2] = i;
  }
  // GIF four-pass order for height 8: rows 0, 4, 2, 6, 1, 3, 5, 7.
  const stored = new Uint8Array([0, 4, 2, 6, 1, 3, 5, 7]);
  const gif = craftGif({
    width: 1,
    height: 8,
    gct,
    frames: [
      {
        left: 0,
        top: 0,
        width: 1,
        height: 8,
        indexes: stored,
        delayCs: 0,
        disposal: 1,
        transparentIndex: undefined,
        interlace: true,
      },
    ],
  });
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 1);
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  for (let y = 0; y < 8; y++) {
    assert.deepEqual(pixelAt(frame, 0, y), [y, y, y, 255], `row ${y}`);
  }
});

test("disposal 3 restores the previous canvas, not the current frame", () => {
  const gif = craft2x2([
    {
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      indexes: new Uint8Array([0, 0, 0, 0]),
      delayCs: 10,
      disposal: 1,
      transparentIndex: undefined,
    },
    {
      left: 1,
      top: 1,
      width: 1,
      height: 1,
      indexes: new Uint8Array([1]),
      delayCs: 10,
      disposal: 3,
      transparentIndex: undefined,
    },
    {
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      indexes: new Uint8Array([1]),
      delayCs: 10,
      disposal: 1,
      transparentIndex: undefined,
    },
  ]);
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 3);
  const f0 = decoded.frames[0];
  const f1 = decoded.frames[1];
  const f2 = decoded.frames[2];
  assert.ok(f0 !== undefined && f1 !== undefined && f2 !== undefined);
  assert.deepEqual(pixelAt(f0, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f1, 1, 1), [0, 0, 255, 255]);
  // Frame 2 draws blue at (0,0) onto the restored (all-red) canvas.
  assert.deepEqual(pixelAt(f2, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixelAt(f2, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f2, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(f2, 0, 1), [255, 0, 0, 255]);
});

test("image descriptor outside the logical screen throws", () => {
  const gif = craft2x2([
    {
      left: 2,
      top: 0,
      width: 1,
      height: 1,
      indexes: new Uint8Array([0]),
      delayCs: 0,
      disposal: 1,
      transparentIndex: undefined,
    },
  ]);
  assert.throws(() => decodeGif(gif), /GIF: image descriptor is outside the logical screen/);
});

test("oversized image descriptor exceeds maxPixels", () => {
  const gif = craftGif({
    width: 1,
    height: 1,
    gct: new Uint8Array([0, 0, 0, 255, 255, 255]),
    frames: [
      {
        left: 0,
        top: 0,
        width: 200,
        height: 200,
        indexes: new Uint8Array(1),
        delayCs: 0,
        disposal: 1,
        transparentIndex: undefined,
      },
    ],
  });
  assert.throws(() => decodeGif(gif, { maxPixels: 100 }), /GIF: 200x200 exceeds maxPixels/);
});

function gifManyTinyFrames(canvasW: number, canvasH: number, n: number): Uint8Array {
  const lzw = encodeLzw(2, new Uint8Array([0]));
  const out: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  push16(out, canvasW);
  push16(out, canvasH);
  out.push(0x80, 0, 0, 0, 0, 0, 255, 255, 255);
  for (let i = 0; i < n; i++) {
    out.push(0x21, 0xf9, 4, 0x08, 2, 0, 0, 0);
    out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, lzw.length);
    for (let j = 0; j < lzw.length; j++) {
      out.push(lzw[j] ?? 0);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

test("250-frame 512×512 file is bounded by maxPixels total canvas pixels", () => {
  const gif = gifManyTinyFrames(512, 512, 250);
  const perFrame = 512 * 512;
  assert.throws(
    () => decodeGif(gif, { maxPixels: perFrame * 10 }),
    /GIF: 11 frames of 512x512 exceed maxPixels \(2883584 > 2621440\); raise maxPixels/,
  );
  const decoded = decodeGif(gif, { maxPixels: perFrame * 250 });
  assert.equal(decoded.frames.length, 250);
  assert.equal(decoded.width, 512);
  assert.equal(decoded.height, 512);
});

test("LZW stream longer than the frame rectangle throws", () => {
  const indexes = new Uint8Array(64);
  const gif = craftGif({
    width: 1,
    height: 1,
    gct: new Uint8Array([0, 0, 0, 255, 255, 255]),
    frames: [
      {
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        indexes,
        delayCs: 0,
        disposal: 1,
        transparentIndex: undefined,
      },
    ],
  });
  assert.throws(() => decodeGif(gif), /GIF: LZW data exceeds frame size/);
});

test("header-only GIF throws without requiring a raster", () => {
  const out: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  push16(out, 7000);
  push16(out, 7000);
  out.push(0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x3b);
  assert.throws(() => decodeGif(new Uint8Array(out)), /GIF: has no image data/);
});

test("truncated sub-block throws", () => {
  const gif = encodeGif(fill(2, 2, () => [1, 2, 3, 255]));
  assert.throws(
    () => decodeGif(gif.subarray(0, 10)),
    /GIF: (invalid header|unexpected end of data)/,
  );
  const cut = gif.subarray(0, gif.length - 3);
  assert.throws(() => decodeGif(cut), /GIF: unexpected end of data/);
});

test("no NETSCAPE block decodes as loop undefined", () => {
  const gif = craftGif({
    width: 1,
    height: 1,
    gct: new Uint8Array([255, 0, 0, 0, 0, 0]),
    frames: [
      {
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        indexes: new Uint8Array([0]),
        delayCs: 0,
        disposal: 1,
        transparentIndex: undefined,
      },
    ],
  });
  const decoded = decodeGif(gif);
  assert.equal(decoded.loop, undefined);
});
