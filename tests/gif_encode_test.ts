import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, decodeGif, encodeGif } from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import { untyped } from "./untyped.ts";

const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const;

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

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  if (needle.length === 0 || bytes.length < needle.length) {
    return false;
  }
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

test("GIF89a header and trailer", () => {
  const gif = encodeGif(createPixelBuffer(1, 1));
  assert.deepEqual([...gif.subarray(0, 6)], [...GIF89A]);
  assert.equal(gif[gif.length - 1], 0x3b);
});

test("1×1 red still roundtrips RGB", () => {
  const image = fill(1, 1, () => [255, 0, 0, 255]);
  const decoded = decodeGif(encodeGif(image));
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.equal(decoded.frames.length, 1);
  const [r, g, b, a] = pixelAt(decoded.frames[0] ?? image, 0, 0);
  assert.ok(Math.abs(r - 255) <= 2);
  assert.ok(g <= 2);
  assert.ok(b <= 2);
  assert.equal(a, 255);
});

test("6×4 two-color checkerboard roundtrips (LZW EOI code-width bump)", () => {
  const image = fill(6, 4, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const decoded = decodeGif(encodeGif(image, { maxColors: 2 }));
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.deepEqual(frame.data, image.data);
});

test("8×8 two-color checkerboard is exact when maxColors ≥ 2", () => {
  const image = fill(8, 8, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const decoded = decodeGif(encodeGif(image, { maxColors: 2 }));
  assert.equal(decoded.frames.length, 1);
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.deepEqual(frame.data, image.data);
});

test("transparent pixel decodes to alpha 0", () => {
  const image = fill(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [255, 0, 0, 0]));
  const decoded = decodeGif(encodeGif(image));
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.equal(pixelAt(frame, 1, 0)[3], 0);
});

test("two-frame animation preserves delays, frames, and loop 0", () => {
  const red = fill(2, 2, () => [255, 0, 0, 255]);
  const blue = fill(2, 2, () => [0, 0, 255, 255]);
  const gif = encodeGif(
    [
      { ...red, delay: 120 },
      { ...blue, delay: 240 },
    ],
    { loop: 0 },
  );
  assert.ok(containsAscii(gif, "NETSCAPE"));
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 2);
  assert.deepEqual(decoded.delays, [120, 240]);
  assert.equal(decoded.loop, 0);
  const [r0] = pixelAt(decoded.frames[0] ?? red, 0, 0);
  const [, , b1] = pixelAt(decoded.frames[1] ?? blue, 0, 0);
  assert.ok(r0 >= 200);
  assert.ok(b1 >= 200);
});

test("still GIF has no NETSCAPE block", () => {
  const gif = encodeGif(fill(3, 2, () => [10, 20, 30, 255]));
  assert.equal(containsAscii(gif, "NETSCAPE"), false);
});

test("LZW roundtrip via decode preserves pixels", () => {
  const image = fill(16, 8, (x, y) => {
    const i = (x + y * 2) % 8;
    return [i * 32, 0, 255 - i * 32, 255];
  });
  const decoded = decodeGif(encodeGif(image, { maxColors: 8 }));
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 8);
  assert.equal(decoded.frames.length, 1);
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.deepEqual(frame.data, image.data);
});

test("decodeGif rejects a bad header", () => {
  assert.throws(() => decodeGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /header/);
});

test("decodeGif rejects truncated bytes", () => {
  const gif = encodeGif(fill(2, 2, () => [1, 2, 3, 255]));
  assert.throws(() => decodeGif(gif.subarray(0, 10)), /header|end|truncated/i);
});

test("GIF87a stills decode", () => {
  const gif = encodeGif(fill(1, 1, () => [0, 255, 0, 255]));
  gif[4] = 0x37;
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 1);
  const [, g] = pixelAt(decoded.frames[0] ?? createPixelBuffer(1, 1), 0, 0);
  assert.ok(g >= 200);
});

test("mismatched animation frame sizes throw", () => {
  assert.throws(() => encodeGif([createPixelBuffer(2, 2), createPixelBuffer(3, 2)]), /match/);
});

test("every alpha < 128 maps to the reserved transparent index", () => {
  const image = fill(3, 1, (x) => {
    if (x === 0) {
      return [255, 0, 0, 0];
    }
    if (x === 1) {
      return [0, 0, 255, 0];
    }
    return [0, 255, 0, 255];
  });
  const decoded = decodeGif(encodeGif(image));
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.equal(pixelAt(frame, 0, 0)[3], 0);
  assert.equal(pixelAt(frame, 1, 0)[3], 0);
  assert.equal(pixelAt(frame, 2, 0)[3], 255);
  const [, g] = pixelAt(frame, 2, 0);
  assert.ok(g >= 250);
  assert.deepEqual(
    [pixelAt(frame, 0, 0)[3], pixelAt(frame, 1, 0)[3], pixelAt(frame, 2, 0)[3]],
    [0, 0, 255],
  );
});

test("fully transparent second frame decodes as transparent", () => {
  const red = fill(2, 2, () => [255, 0, 0, 255]);
  const clear = fill(2, 2, () => [10, 20, 30, 0]);
  const decoded = decodeGif(encodeGif([red, clear]));
  assert.equal(decoded.frames.length, 2);
  const frame = decoded.frames[1];
  assert.ok(frame !== undefined);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      assert.deepEqual(pixelAt(frame, x, y), [0, 0, 0, 0]);
    }
  }
});

test("disjoint 200-color frames roundtrip with local palettes", () => {
  const frameA = fill(20, 10, (x, y) => {
    const i = y * 20 + x;
    return [i, 0, 0, 255];
  });
  const frameB = fill(20, 10, (x, y) => {
    const i = y * 20 + x;
    return [0, i, 255, 255];
  });
  const decoded = decodeGif(encodeGif([frameA, frameB]));
  assert.equal(decoded.frames.length, 2);
  const outA = decoded.frames[0];
  const outB = decoded.frames[1];
  assert.ok(outA !== undefined);
  assert.ok(outB !== undefined);
  assert.deepEqual(outA.data, frameA.data);
  assert.deepEqual(outB.data, frameB.data);
});

test("alpha 127 is transparent and 128 is opaque", () => {
  const image = fill(2, 1, (x) => (x === 0 ? [255, 0, 0, 127] : [0, 255, 0, 128]));
  const decoded = decodeGif(encodeGif(image));
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  assert.equal(pixelAt(frame, 0, 0)[3], 0);
  assert.equal(pixelAt(frame, 1, 0)[3], 255);
});

test("dithering does not paint or leak into transparent pixels", () => {
  const image = fill(8, 4, (x) =>
    x < 2 ? [255, 128, 0, 0] : [Math.round((x / 7) * 255), 40, 200, 255],
  );
  const decoded = decodeGif(encodeGif(image, { maxColors: 4, dither: "floyd-steinberg" }));
  const frame = decoded.frames[0];
  assert.ok(frame !== undefined);
  for (let y = 0; y < 4; y++) {
    assert.equal(pixelAt(frame, 0, y)[3], 0);
    assert.equal(pixelAt(frame, 1, y)[3], 0);
  }
});

test("identical consecutive animation frames merge delays (summed, not doubled)", () => {
  const red = fill(2, 2, () => [255, 0, 0, 255]);
  const blue = fill(2, 2, () => [0, 0, 255, 255]);
  const decoded = decodeGif(
    encodeGif([
      { ...red, delay: 100 },
      { ...red, delay: 150 },
      { ...blue, delay: 90 },
    ]),
  );
  assert.equal(decoded.frames.length, 2);
  assert.deepEqual(decoded.delays, [250, 90]);
  const f0 = decoded.frames[0];
  const f1 = decoded.frames[1];
  assert.ok(f0 !== undefined);
  assert.ok(f1 !== undefined);
  assert.deepEqual(f0.data, red.data);
  assert.deepEqual(f1.data, blue.data);
});

test("duplicate frames that would overflow the delay cap are kept", () => {
  const red = fill(2, 2, () => [255, 0, 0, 255]);
  const decoded = decodeGif(
    encodeGif([
      { ...red, delay: 655350 },
      { ...red, delay: 10 },
    ]),
  );
  assert.equal(decoded.frames.length, 2);
  assert.deepEqual(decoded.delays, [655350, 10]);
});

test("moving sprite uses a partial-canvas dirty rect", () => {
  const frames: PixelBuffer[] = [];
  for (let f = 0; f < 4; f++) {
    frames.push(
      fill(32, 32, (x, y) => {
        if (x >= f * 4 && x < f * 4 + 8 && y >= 4 && y < 12) {
          return [255, 0, 0, 255];
        }
        return [0, 80, 0, 255];
      }),
    );
  }
  const gif = encodeGif(frames.map((frame) => ({ ...frame, delay: 70 })));
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 4);
  for (let i = 0; i < frames.length; i++) {
    const got = decoded.frames[i];
    const want = frames[i];
    assert.ok(got !== undefined);
    assert.ok(want !== undefined);
    assert.deepEqual(got.data, want.data);
  }

  const descriptors: { left: number; top: number; width: number; height: number }[] = [];
  let pos = 13;
  const packed = gif[10] ?? 0;
  if ((packed & 0x80) !== 0) {
    pos += (2 << (packed & 7)) * 3;
  }
  while (pos < gif.length) {
    const sep = gif[pos];
    if (sep === 0x3b || sep === undefined) {
      break;
    }
    if (sep === 0x21) {
      const label = gif[pos + 1];
      pos += 2;
      if (label === 0xff) {
        const idSize = gif[pos] ?? 0;
        pos += 1 + idSize;
      }
      for (;;) {
        const size = gif[pos] ?? 0;
        pos += 1;
        if (size === 0) {
          break;
        }
        pos += size;
      }
      continue;
    }
    if (sep !== 0x2c) {
      break;
    }
    const left = (gif[pos + 1] ?? 0) | ((gif[pos + 2] ?? 0) << 8);
    const top = (gif[pos + 3] ?? 0) | ((gif[pos + 4] ?? 0) << 8);
    const width = (gif[pos + 5] ?? 0) | ((gif[pos + 6] ?? 0) << 8);
    const height = (gif[pos + 7] ?? 0) | ((gif[pos + 8] ?? 0) << 8);
    descriptors.push({ left, top, width, height });
    pos += 10;
    const descPacked = gif[pos - 1] ?? 0;
    if ((descPacked & 0x80) !== 0) {
      pos += (2 << (descPacked & 7)) * 3;
    }
    pos += 1;
    for (;;) {
      const size = gif[pos] ?? 0;
      pos += 1;
      if (size === 0) {
        break;
      }
      pos += size;
    }
  }
  assert.ok(descriptors.length >= 2);
  const first = descriptors[0];
  const second = descriptors[1];
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  assert.ok(
    second.width * second.height < first.width * first.height,
    `dirty rect should shrink (${second.width}x${second.height} vs ${first.width}x${first.height})`,
  );
  assert.ok(second.width * second.height < 32 * 32);
});

test("source-transparent sprite over a previous pixel is lossless", () => {
  const a = fill(8, 8, (x, y) => (x < 4 && y < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const b = fill(8, 8, (x, y) =>
    x >= 2 && x < 6 && y >= 2 && y < 6 ? [0, 0, 255, 255] : [0, 0, 0, 0],
  );
  const decoded = decodeGif(encodeGif([a, b]));
  assert.equal(decoded.frames.length, 2);
  const outA = decoded.frames[0];
  const outB = decoded.frames[1];
  assert.ok(outA !== undefined);
  assert.ok(outB !== undefined);
  assert.deepEqual(outA.data, a.data);
  assert.deepEqual(outB.data, b.data);
});

test("loop undefined omits NETSCAPE; 0 loops forever; n is finite", () => {
  const red = fill(2, 2, () => [255, 0, 0, 255]);
  const blue = fill(2, 2, () => [0, 0, 255, 255]);
  const once = encodeGif([red, blue]);
  assert.equal(containsAscii(once, "NETSCAPE"), false);
  assert.equal(decodeGif(once).loop, undefined);

  const forever = encodeGif([red, blue], { loop: 0 });
  assert.ok(containsAscii(forever, "NETSCAPE"));
  assert.equal(decodeGif(forever).loop, 0);

  const three = encodeGif([red, blue], { loop: 3 });
  assert.ok(containsAscii(three, "NETSCAPE"));
  assert.equal(decodeGif(three).loop, 3);

  const stillLoop = encodeGif(red, { loop: 0 });
  assert.ok(containsAscii(stillLoop, "NETSCAPE"));
  assert.equal(decodeGif(stillLoop).loop, 0);
});

test("delays round-trip in milliseconds", () => {
  const red = fill(1, 1, () => [255, 0, 0, 255]);
  const blue = fill(1, 1, () => [0, 0, 255, 255]);
  const decoded = decodeGif(
    encodeGif(
      [
        { ...red, delay: 0 },
        { ...blue, delay: 100 },
        { ...red, delay: 250 },
      ],
      { loop: 1 },
    ),
  );
  assert.deepEqual(decoded.delays, [0, 100, 250]);
});

test("encodeGif rejects invalid options up front", () => {
  const image = fill(1, 1, () => [0, 0, 0, 255]);
  assert.throws(
    () => encodeGif(image, { dither: untyped("ordered") }),
    /GIF: dither must be "none" or "floyd-steinberg"/,
  );
  assert.throws(
    () => encodeGif(image, { palette: untyped("per-frame") }),
    /GIF: palette must be "local" or "global"/,
  );
  assert.throws(() => encodeGif(image, { maxColors: 1 }), /GIF: maxColors/);
  assert.throws(() => encodeGif(image, { loop: -1 }), /GIF: loop/);
  assert.throws(() => encodeGif([{ ...image, delay: -1 }]), /GIF: delay/);
  assert.throws(() => encodeGif([{ ...image, disposal: 4 }]), /GIF: disposal/);
});

test("floyd-steinberg dithering lowers mean abs error on a gradient", () => {
  const image = fill(64, 8, (x) => {
    const t = x / 63;
    return [Math.round(t * 255), 80, Math.round((1 - t) * 255), 255];
  });
  const snapped = decodeGif(encodeGif(image, { maxColors: 8, dither: "none" }));
  const dithered = decodeGif(encodeGif(image, { maxColors: 8, dither: "floyd-steinberg" }));
  const snapFrame = snapped.frames[0];
  const ditherFrame = dithered.frames[0];
  assert.ok(snapFrame !== undefined);
  assert.ok(ditherFrame !== undefined);
  assert.notDeepEqual(ditherFrame.data, snapFrame.data);

  const blockMae = (out: PixelBuffer, block: number): number => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < image.height; y += block) {
      for (let x = 0; x < image.width; x += block) {
        const accSrc = [0, 0, 0];
        const accOut = [0, 0, 0];
        let count = 0;
        for (let dy = 0; dy < block && y + dy < image.height; dy++) {
          for (let dx = 0; dx < block && x + dx < image.width; dx++) {
            const i = ((y + dy) * image.width + (x + dx)) * 4;
            for (let c = 0; c < 3; c++) {
              accSrc[c] = (accSrc[c] ?? 0) + (image.data[i + c] ?? 0);
              accOut[c] = (accOut[c] ?? 0) + (out.data[i + c] ?? 0);
            }
            count += 1;
          }
        }
        if (count === 0) {
          continue;
        }
        for (let c = 0; c < 3; c++) {
          sum += Math.abs((accSrc[c] ?? 0) / count - (accOut[c] ?? 0) / count);
          n += 1;
        }
      }
    }
    return n === 0 ? 0 : sum / n;
  };

  assert.ok(blockMae(ditherFrame, 4) < blockMae(snapFrame, 4));
});
