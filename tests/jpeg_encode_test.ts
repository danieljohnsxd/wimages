import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, decodeJpeg, encodeJpeg } from "../dist/index.js";
import type { JpegEncodeOptions, PixelBuffer } from "../dist/index.js";
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

function solid(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): PixelBuffer {
  return fillPixels(width, height, () => [r, g, b, a]);
}

function channelMae(a: PixelBuffer, b: PixelBuffer): number {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    sum += Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    sum += Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    n += 3;
  }
  return n === 0 ? 0 : sum / n;
}

function maxAbsErr(a: PixelBuffer, b: PixelBuffer): number {
  let m = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    m = Math.max(m, Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)));
    m = Math.max(m, Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)));
    m = Math.max(m, Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)));
  }
  return m;
}

function roundtrip(image: PixelBuffer, options?: JpegEncodeOptions): PixelBuffer {
  const jpeg = encodeJpeg(image, options);
  const decoded = decodeJpeg(jpeg);
  assert.equal(decoded.width, image.width);
  assert.equal(decoded.height, image.height);
  assert.equal(decoded.data.length, image.width * image.height * 4);
  return decoded;
}

test("JPEG SOI is 0xFFD8 and EOI is 0xFFD9", () => {
  const jpeg = encodeJpeg(createPixelBuffer(1, 1));
  assert.ok(jpeg.length >= 4);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg[jpeg.length - 2], 0xff);
  assert.equal(jpeg[jpeg.length - 1], 0xd9);
});

test("1x1 red at quality 95 stays within 2 per channel", () => {
  const src = solid(1, 1, 255, 0, 0);
  const decoded = roundtrip(src, { quality: 95 });
  assert.ok(maxAbsErr(src, decoded) <= 2, `maxAbs=${maxAbsErr(src, decoded)}`);
  assert.equal(decoded.data[3], 255);
});

test("1x1 red at quality 75 stays recognizable", () => {
  const decoded = roundtrip(solid(1, 1, 255, 0, 0), { quality: 75 });
  const r = decoded.data[0] ?? 0;
  const g = decoded.data[1] ?? 0;
  const b = decoded.data[2] ?? 0;
  assert.ok(r > 200, `R=${r}`);
  assert.ok(g < 40, `G=${g}`);
  assert.ok(b < 40, `B=${b}`);
});

test("8x8 gradient encode/decode has reasonable error", () => {
  const src = fillPixels(8, 8, (x, y) => [
    Math.round((x * 255) / 7),
    Math.round((y * 255) / 7),
    128,
    255,
  ]);
  const decoded = roundtrip(src, { quality: 95 });
  assert.ok(channelMae(src, decoded) < 6, `mae=${channelMae(src, decoded)}`);
  assert.ok(maxAbsErr(src, decoded) <= 25, `maxAbs=${maxAbsErr(src, decoded)}`);
});

test("16x16 photo-ish noise encode/decode has reasonable error", () => {
  const src = fillPixels(16, 16, (x, y) => {
    const r = Math.round(128 + 80 * Math.sin(x * 0.4) + 18 * Math.cos(y * 0.55));
    const g = Math.round(110 + 70 * Math.cos(x * 0.35) + 30 * Math.sin(y * 0.45));
    const b = Math.round(90 + 85 * Math.sin((x + y) * 0.25));
    return [
      Math.min(255, Math.max(0, r)),
      Math.min(255, Math.max(0, g)),
      Math.min(255, Math.max(0, b)),
      255,
    ];
  });
  const decoded = roundtrip(src, { quality: 75 });
  assert.ok(channelMae(src, decoded) < 8, `mae=${channelMae(src, decoded)}`);
});

test("quality 30 file is smaller than quality 90", () => {
  let seed = 99;
  const src = fillPixels(16, 16, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255];
  });
  const q30 = encodeJpeg(src, { quality: 30 });
  const q90 = encodeJpeg(src, { quality: 90 });
  assert.ok(q30.length < q90.length, `q30=${q30.length} q90=${q90.length}`);
});

test("4:4:4 and 4:2:0 both decode", () => {
  const src = fillPixels(8, 8, (x, y) => [x * 30, y * 30, 80, 255]);
  const aJpeg = encodeJpeg(src, { chroma: "4:4:4", quality: 90 });
  const bJpeg = encodeJpeg(src, { chroma: "4:2:0", quality: 90 });
  assert.equal(parseJpegStructure(aJpeg).ySample, 0x11);
  assert.equal(parseJpegStructure(bJpeg).ySample, 0x22);
  const a = decodeJpeg(aJpeg);
  const b = decodeJpeg(bJpeg);
  assert.equal(a.width, 8);
  assert.equal(b.width, 8);
  assert.equal(a.data[3], 255);
  assert.equal(b.data[3], 255);
  assert.ok(channelMae(src, a) < 6, `4:4:4 mae=${channelMae(src, a)}`);
  assert.ok(channelMae(src, b) < 15, `4:2:0 mae=${channelMae(src, b)}`);
});

test("decodeJpeg rejects empty and bad SOI", () => {
  assert.throws(() => decodeJpeg(new Uint8Array(0)), /JPEG: empty input/);
  assert.throws(() => decodeJpeg(new Uint8Array([0xff, 0xd9])), /JPEG: invalid signature/);
  assert.throws(() => decodeJpeg(new Uint8Array([0x00, 0x00])), /JPEG: invalid signature/);
  assert.throws(() => decodeJpeg(new Uint8Array([0xff])), /JPEG: empty input/);
});

test("transparent red composites on white", () => {
  const src = solid(1, 1, 255, 0, 0, 0);
  const decoded = roundtrip(src, { quality: 95 });
  const r = decoded.data[0] ?? 0;
  const g = decoded.data[1] ?? 0;
  const b = decoded.data[2] ?? 0;
  assert.ok(r > 220, `R=${r}`);
  assert.ok(g > 220, `G=${g}`);
  assert.ok(b > 220, `B=${b}`);
});

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function gradient8(): PixelBuffer {
  return fillPixels(8, 8, (x, y) => [
    Math.round((x * 255) / 7),
    Math.round((y * 255) / 7),
    128,
    255,
  ]);
}

type SosHeader = {
  readonly n: number;
  readonly ss: number;
  readonly se: number;
  readonly ah: number;
  readonly al: number;
  readonly comps: readonly { readonly id: number; readonly tdta: number }[];
};

type JpegStructure = {
  readonly sof: number;
  readonly width: number;
  readonly height: number;
  readonly ySample: number;
  readonly lumQ0: number;
  readonly sos: SosHeader[];
  readonly dht: { readonly classId: number; readonly nsym: number }[];
};

function skipEntropy(jpeg: Uint8Array, start: number): number {
  let i = start;
  while (i < jpeg.length) {
    const b = jpeg[i];
    if (b !== 0xff) {
      i += 1;
      continue;
    }
    const n = jpeg[i + 1];
    if (n === undefined) {
      return i;
    }
    if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
      i += 2;
      continue;
    }
    if (n === 0xff) {
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

function parseJpegStructure(jpeg: Uint8Array): JpegStructure {
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  let i = 2;
  let sof = 0;
  let width = 0;
  let height = 0;
  let ySample = 0;
  let lumQ0 = 0;
  const sos: SosHeader[] = [];
  const dht: { classId: number; nsym: number }[] = [];
  while (i + 1 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      throw new Error(`expected marker at ${i}`);
    }
    while (i < jpeg.length && jpeg[i] === 0xff) {
      i += 1;
    }
    const marker = jpeg[i];
    if (marker === undefined) {
      break;
    }
    i += 1;
    if (marker === 0xd9) {
      break;
    }
    if (marker === 0xda) {
      const len = ((jpeg[i] ?? 0) << 8) | (jpeg[i + 1] ?? 0);
      const payload = jpeg.subarray(i + 2, i + len);
      const n = payload[0] ?? 0;
      const comps: { id: number; tdta: number }[] = [];
      let p = 1;
      for (let c = 0; c < n; c++) {
        comps.push({ id: payload[p] ?? 0, tdta: payload[p + 1] ?? 0 });
        p += 2;
      }
      sos.push({
        n,
        comps,
        ss: payload[p] ?? 0,
        se: payload[p + 1] ?? 0,
        ah: (payload[p + 2] ?? 0) >> 4,
        al: (payload[p + 2] ?? 0) & 0x0f,
      });
      i = skipEntropy(jpeg, i + len);
      continue;
    }
    const len = ((jpeg[i] ?? 0) << 8) | (jpeg[i + 1] ?? 0);
    const payload = jpeg.subarray(i + 2, i + len);
    i += len;
    if (marker === 0xc0 || marker === 0xc2) {
      sof = marker;
      height = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
      width = ((payload[3] ?? 0) << 8) | (payload[4] ?? 0);
      ySample = payload[7] ?? 0;
    } else if (marker === 0xdb) {
      const id = payload[0] ?? 0;
      if ((id & 0x0f) === 0) {
        lumQ0 = payload[1] ?? 0;
      }
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < payload.length) {
        const classId = payload[p] ?? 0;
        p += 1;
        let nsym = 0;
        for (let b = 0; b < 16; b++) {
          nsym += payload[p + b] ?? 0;
        }
        dht.push({ classId, nsym });
        p += 16 + nsym;
      }
    }
  }
  return { sof, width, height, ySample, lumQ0, sos, dht };
}

test("optimized Huffman omits unused symbols", () => {
  const jpeg = encodeJpeg(solid(8, 8, 128, 128, 128), { quality: 75 });
  const st = parseJpegStructure(jpeg);
  const acLum = st.dht.find((t) => t.classId === 0x10);
  assert.ok(acLum !== undefined);
  assert.ok(acLum.nsym < 162, `AC luma symbols=${acLum.nsym}`);
  assert.ok(acLum.nsym >= 1);
  roundtrip(solid(8, 8, 128, 128, 128), { quality: 75 });
});

test("quality presets map to documented q and chroma", () => {
  const src = gradient8();
  const small = encodeJpeg(src, { quality: "small" });
  const balanced = encodeJpeg(src, { quality: "balanced" });
  const high = encodeJpeg(src, { quality: "high" });
  assert.deepEqual(small, encodeJpeg(src, { quality: 65, chroma: "4:2:0" }));
  assert.deepEqual(balanced, encodeJpeg(src, { quality: 80, chroma: "4:2:0" }));
  assert.deepEqual(high, encodeJpeg(src, { quality: 90, chroma: "4:4:4" }));
  assert.deepEqual(encodeJpeg(src), balanced);

  const s = parseJpegStructure(small);
  const b = parseJpegStructure(balanced);
  const h = parseJpegStructure(high);
  assert.equal(s.ySample, 0x22);
  assert.equal(b.ySample, 0x22);
  assert.equal(h.ySample, 0x11);
  assert.equal(s.lumQ0, 11);
  assert.equal(b.lumQ0, 6);
  assert.equal(h.lumQ0, 3);
});

test("chroma option overrides the preset", () => {
  const src = gradient8();
  const jpeg = encodeJpeg(src, { quality: "high", chroma: "4:2:0" });
  assert.deepEqual(jpeg, encodeJpeg(src, { quality: 90, chroma: "4:2:0" }));
  assert.equal(parseJpegStructure(jpeg).ySample, 0x22);
});

test("rejects invalid quality", () => {
  const src = solid(1, 1, 1, 2, 3, 255);
  assert.throws(() => encodeJpeg(src, { quality: 0 }), /JPEG: quality must be/);
  assert.throws(() => encodeJpeg(src, { quality: 101 }), /JPEG: quality must be/);
  assert.throws(() => encodeJpeg(src, { quality: 1.5 }), /JPEG: quality must be/);
  assert.throws(() => encodeJpeg(src, { quality: untyped("max") }), /JPEG: quality must be/);
  assert.throws(
    () => encodeJpeg(src, { progressive: untyped("yes") }),
    /JPEG: progressive must be a boolean/,
  );
  assert.throws(() => encodeJpeg(src, { chroma: untyped("4:1:1") }), /JPEG: chroma must be/);
});

test("4:2:2 chroma sampling is H=2,V=1 and roundtrips", () => {
  const src = fillPixels(16, 8, (x, y) => [x * 15, y * 30, 80, 255]);
  const jpeg = encodeJpeg(src, { chroma: "4:2:2", quality: 90 });
  const st = parseJpegStructure(jpeg);
  assert.equal(st.sof, 0xc0);
  assert.equal(st.ySample, 0x21);
  const decoded = decodeJpeg(jpeg);
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 8);
  assert.ok(channelMae(src, decoded) < 20);
});

test("4:4:4, 4:2:2, and 4:2:0 all decode", () => {
  const src = fillPixels(8, 8, (x, y) => [x * 30, y * 30, 80, 255]);
  const sample = { "4:4:4": 0x11, "4:2:2": 0x21, "4:2:0": 0x22 } as const;
  for (const chroma of ["4:4:4", "4:2:2", "4:2:0"] as const) {
    const jpeg = encodeJpeg(src, { chroma, quality: 90 });
    assert.equal(parseJpegStructure(jpeg).ySample, sample[chroma], chroma);
    const decoded = decodeJpeg(jpeg);
    assert.equal(decoded.width, 8);
    assert.equal(decoded.data[3], 255);
  }
});

test("half-transparent red on black composites to ~128,0,0", () => {
  const src = solid(16, 16, 255, 0, 0, 128);
  const decoded = roundtrip(src, { quality: 95, chroma: "4:4:4", background: [0, 0, 0] });
  const r = decoded.data[0] ?? 0;
  const g = decoded.data[1] ?? 0;
  const b = decoded.data[2] ?? 0;
  assert.ok(Math.abs(r - 128) < 12, `R=${r}`);
  assert.ok(g < 12, `G=${g}`);
  assert.ok(b < 12, `B=${b}`);
});

test("background defaults to white", () => {
  const src = solid(8, 8, 255, 0, 0, 0);
  const a = encodeJpeg(src, { quality: 95 });
  const b = encodeJpeg(src, { quality: 95, background: [255, 255, 255] });
  assert.deepEqual(a, b);
});

test("background must be three 0–255 integers", () => {
  const src = solid(1, 1, 1, 2, 3, 255);
  assert.throws(() => encodeJpeg(src, { background: [-1, 0, 0] }), RangeError);
  assert.throws(() => encodeJpeg(src, { background: [0, 0, 256] }), RangeError);
  assert.throws(() => encodeJpeg(src, { background: [0.5, 0, 0] }), RangeError);
  assert.throws(() => encodeJpeg(src, { chroma: untyped("4:1:1") }), RangeError);
});

const PROGRESSIVE_SCANS: readonly [number, number, number, number, number][] = [
  [3, 0, 0, 0, 1],
  [1, 1, 5, 0, 2],
  [1, 1, 63, 0, 1],
  [1, 1, 63, 0, 1],
  [1, 6, 63, 0, 2],
  [1, 1, 63, 2, 1],
  [3, 0, 0, 1, 0],
  [1, 1, 63, 1, 0],
  [1, 1, 63, 1, 0],
  [1, 1, 63, 1, 0],
];

test("progressive output is SOF2 with the libjpeg-turbo YCbCr scan script", () => {
  const jpeg = encodeJpeg(gradient8(), { quality: 75, progressive: true });
  const st = parseJpegStructure(jpeg);
  assert.equal(st.sof, 0xc2);
  assert.equal(st.width, 8);
  assert.equal(st.height, 8);
  assert.equal(st.sos.length, 10);
  for (let i = 0; i < PROGRESSIVE_SCANS.length; i++) {
    const exp = PROGRESSIVE_SCANS[i];
    const got = st.sos[i];
    assert.ok(exp !== undefined && got !== undefined);
    assert.equal(got.n, exp[0], `scan ${i} n`);
    assert.equal(got.ss, exp[1], `scan ${i} Ss`);
    assert.equal(got.se, exp[2], `scan ${i} Se`);
    assert.equal(got.ah, exp[3], `scan ${i} Ah`);
    assert.equal(got.al, exp[4], `scan ${i} Al`);
  }
  assert.equal(st.sos[2]?.comps[0]?.id, 3);
  assert.equal(st.sos[3]?.comps[0]?.id, 2);
});

test("progressive uses optimized Huffman", () => {
  const jpeg = encodeJpeg(solid(8, 8, 40, 80, 120), {
    quality: 75,
    progressive: true,
  });
  const st = parseJpegStructure(jpeg);
  assert.equal(st.sof, 0xc2);
  const ac = st.dht.filter((t) => (t.classId & 0xf0) === 0x10);
  assert.ok(ac.length > 0);
  assert.ok(ac.every((t) => t.nsym < 162));
});

/**
 * djpeg -dct float of the progressive 8×8 gradient (q75, 4:2:0).
 */
const DJPEG_PROGRESSIVE_GRADIENT_RGB = [
  4, 2, 111, 25, 7, 115, 62, 10, 118, 99, 10, 116, 138, 7, 109, 175, 6, 107, 210, 9, 113, 231, 14,
  118, 15, 30, 123, 36, 35, 128, 73, 38, 130, 111, 38, 128, 149, 35, 122, 186, 34, 121, 221, 37,
  125, 242, 42, 130, 18, 66, 130, 39, 70, 134, 75, 74, 134, 113, 73, 133, 151, 70, 128, 189, 70,
  126, 225, 73, 130, 245, 78, 134, 16, 102, 129, 37, 107, 133, 74, 110, 134, 111, 109, 131, 149,
  106, 126, 187, 106, 125, 222, 109, 129, 243, 114, 134, 11, 142, 126, 32, 147, 130, 69, 150, 131,
  107, 150, 130, 147, 146, 125, 183, 145, 122, 217, 149, 126, 239, 154, 133, 11, 178, 126, 31, 182,
  127, 68, 185, 130, 106, 185, 128, 146, 181, 123, 182, 182, 122, 217, 185, 126, 238, 189, 131, 15,
  213, 128, 36, 218, 133, 73, 221, 135, 110, 220, 131, 150, 216, 126, 187, 216, 126, 223, 219, 130,
  242, 225, 135, 28, 240, 140, 49, 245, 145, 86, 248, 145, 122, 247, 143, 162, 243, 138, 200, 243,
  136, 234, 247, 142, 255, 252, 147,
];

const GOLDEN_PROGRESSIVE_8X8 = hexBytes(
  "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232ffc20011080008000803012200021101031101ffc4001500010100000000000000000000000000000500ffc4001501010100000000000000000000000000000204ffda000c0301000211031100000193493857ffc400161000030000000000000000000000000000000405ffda00080101000105025e79ffc4001a110000070000000000000000000000000000010304051321ffda0008010311013f018f7cad05a3ffc40017110100030000000000000000000000000003000412ffda0008010211013f015b69a9ffc4001510010100000000000000000000000000000031ffda0008010100063f028fffc4001510010100000000000000000000000000000031ffda0008010100013f2183ffda000c0301000211031100001017ffc40014110100000000000000000000000000000000ffda0008010311013f1051ffc400161100030000000000000000000000000000001121ffda0008010211013f10774fffc40015100101000000000000000000000000000000f1ffda0008010100013f109cffd9",
);

test("progressive 8x8 gradient matches captured bitstream and djpeg RGB", () => {
  const jpeg = encodeJpeg(gradient8(), { quality: 75, progressive: true, chroma: "4:2:0" });
  assert.deepEqual(jpeg, GOLDEN_PROGRESSIVE_8X8);
  const st = parseJpegStructure(jpeg);
  assert.equal(st.sof, 0xc2);
  assert.equal(st.sos.length, 10);
  assert.equal(DJPEG_PROGRESSIVE_GRADIENT_RGB.length, 8 * 8 * 3);
  const decoded = decodeJpeg(jpeg);
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let i = 0; i < 64; i++) {
    const o = i * 4;
    const p = i * 3;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs((decoded.data[o + c] ?? 0) - (DJPEG_PROGRESSIVE_GRADIENT_RGB[p + c] ?? 0));
      sum += d;
      if (d > max) {
        max = d;
      }
      n += 1;
    }
    assert.equal(decoded.data[o + 3], 255);
  }
  const mae = n === 0 ? 0 : sum / n;
  assert.ok(mae <= 1, `progressive vs djpeg mae=${mae} max=${max}`);
  assert.ok(max <= 8, `progressive vs djpeg maxAbs=${max}`);
});

test("progressive 4:2:2 uses Y sampling 0x21 and ten scans", () => {
  const jpeg = encodeJpeg(solid(16, 8, 200, 10, 30), {
    quality: 90,
    progressive: true,
    chroma: "4:2:2",
  });
  const st = parseJpegStructure(jpeg);
  assert.equal(st.sof, 0xc2);
  assert.equal(st.ySample, 0x21);
  assert.equal(st.sos.length, 10);
});

function photo(width: number, height: number): PixelBuffer {
  let seed = 12345;
  return fillPixels(width, height, (x, y) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed >>> 26) & 7;
    return [
      ((x * 255) / width + noise) & 255,
      ((y * 255) / height + noise) & 255,
      (128 + 100 * Math.sin(x / 7) * Math.cos(y / 5) + noise) & 255,
      255,
    ];
  });
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CHROMA_SAMPLE = { "4:2:0": 0x22, "4:2:2": 0x21, "4:4:4": 0x11 } as const;

test("progressive odd sizes keep SOF2 structure at every chroma", () => {
  const sizes = [
    [37, 29],
    [53, 41],
    [100, 75],
  ] as const;
  for (const [width, height] of sizes) {
    const src = photo(width, height);
    for (const chroma of ["4:2:0", "4:2:2", "4:4:4"] as const) {
      const jpeg = encodeJpeg(src, { quality: 75, chroma, progressive: true });
      const st = parseJpegStructure(jpeg);
      assert.equal(st.sof, 0xc2, `${width}x${height} ${chroma} SOF`);
      assert.equal(st.width, width);
      assert.equal(st.height, height);
      assert.equal(st.ySample, CHROMA_SAMPLE[chroma]);
      assert.equal(st.sos.length, 10);
      for (let i = 0; i < PROGRESSIVE_SCANS.length; i++) {
        const exp = PROGRESSIVE_SCANS[i];
        const got = st.sos[i];
        assert.ok(exp !== undefined && got !== undefined);
        assert.equal(got.n, exp[0], `${width}x${height} ${chroma} scan ${i} n`);
        assert.equal(got.ss, exp[1], `${width}x${height} ${chroma} scan ${i} Ss`);
        assert.equal(got.se, exp[2], `${width}x${height} ${chroma} scan ${i} Se`);
        assert.equal(got.ah, exp[3], `${width}x${height} ${chroma} scan ${i} Ah`);
        assert.equal(got.al, exp[4], `${width}x${height} ${chroma} scan ${i} Al`);
      }
    }
  }
});

test("progressive 37x29 4:2:0 bitstream is stable and decodes like sequential", () => {
  const src = photo(37, 29);
  const jpeg = encodeJpeg(src, { quality: 75, chroma: "4:2:0", progressive: true });
  assert.equal(jpeg.length, 716);
  assert.equal(fnv1a(jpeg), 0xb8343421);
  assert.equal(parseJpegStructure(jpeg).sof, 0xc2);
  const progressive = decodeJpeg(jpeg);
  const sequential = decodeJpeg(encodeJpeg(src, { quality: 75, chroma: "4:2:0" }));
  assert.equal(progressive.width, 37);
  assert.equal(progressive.height, 29);
  assert.ok(
    channelMae(progressive, sequential) < 0.05,
    `mae=${channelMae(progressive, sequential)}`,
  );
});
