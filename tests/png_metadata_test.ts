import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { test } from "node:test";
import {
  createPixelBuffer,
  decodePng,
  encodePng,
  exifOrientation,
  readImageMetadata,
  withExifOrientation,
} from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import {
  assemblePng,
  buildExifTiff,
  parsePngChunks,
  writeIndependentPng,
} from "./png_decode_helper.ts";

function fillPixels(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): PixelBuffer {
  const image = createPixelBuffer(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = (y * width + x) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = a;
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

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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

const XMP_KEYWORD = "XML:com.adobe.xmp";
const SAMPLE_XMP = latin1(
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
);

function insertAfterIhdr(png: Uint8Array, chunk: { type: string; data: Uint8Array }): Uint8Array {
  const chunks = parsePngChunks(png);
  const out: typeof chunks = [];
  for (const c of chunks) {
    out.push(c);
    if (c.type === "IHDR") {
      out.push(chunk);
    }
  }
  return assemblePng(out);
}

function compressedXmpItxt(xmp: Uint8Array): Uint8Array {
  const keyword = latin1(XMP_KEYWORD);
  return concatBytes([keyword, new Uint8Array([0, 1, 0, 0, 0]), new Uint8Array(deflateSync(xmp))]);
}

test("readImageMetadata inflates compressed iTXt XMP", () => {
  const png = encodePng(fillPixels(2, 2, () => [10, 20, 30, 255]));
  const withXmp = insertAfterIhdr(png, { type: "iTXt", data: compressedXmpItxt(SAMPLE_XMP) });
  const meta = readImageMetadata(withXmp);
  assert.deepEqual(meta.xmp, SAMPLE_XMP);
});

test("malformed compressed iTXt is skipped, not fatal", () => {
  const png = encodePng(fillPixels(2, 2, () => [10, 20, 30, 255]));
  const keyword = latin1(XMP_KEYWORD);
  const garbage = concatBytes([keyword, new Uint8Array([0, 1, 0, 0, 0, 1, 2, 3, 4])]);
  const withBad = insertAfterIhdr(png, { type: "iTXt", data: garbage });
  const meta = readImageMetadata(withBad);
  assert.equal(meta.xmp, undefined);
  assert.equal(decodePng(withBad).width, 2);
});

test("encodePng compresses large XMP iTXt and round-trips", () => {
  const xmp = new Uint8Array(8000);
  for (let i = 0; i < xmp.length; i++) {
    xmp[i] = (i * 13 + 7) & 0xff;
  }
  const png = encodePng(
    fillPixels(2, 2, () => [1, 2, 3, 255]),
    { metadata: { xmp } },
  );
  const itxt = parsePngChunks(png).find((c) => c.type === "iTXt");
  assert.ok(itxt !== undefined);
  const keyEnd = XMP_KEYWORD.length;
  assert.equal(itxt.data[keyEnd], 0);
  assert.equal(itxt.data[keyEnd + 1], 1);
  assert.equal(itxt.data[keyEnd + 2], 0);
  const textStart = keyEnd + 5;
  const inflated = new Uint8Array(inflateSync(itxt.data.subarray(textStart)));
  assert.deepEqual(inflated, xmp);
  assert.deepEqual(readImageMetadata(png).xmp, xmp);
});

test("decodePng applies eXIf orientation 6 and ignore leaves file order", () => {
  const src = fillPixels(4, 2, (x) => (x < 2 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const png = writeIndependentPng({
    width: 4,
    height: 2,
    colorType: 6,
    rgba: src.data,
    extraAfterIhdr: [{ type: "eXIf", data: buildExifTiff(6) }],
  });
  const ignored = decodePng(png, { orientation: "ignore" });
  assert.equal(ignored.width, 4);
  assert.equal(ignored.height, 2);
  assert.deepEqual(ignored.data, src.data);

  const applied = decodePng(png);
  assert.equal(applied.width, 2);
  assert.equal(applied.height, 4);
  assert.deepEqual(pixelAt(applied, 0, 0), [220, 20, 20, 255]);
  assert.deepEqual(pixelAt(applied, 1, 0), [220, 20, 20, 255]);
  assert.deepEqual(pixelAt(applied, 0, 3), [20, 20, 220, 255]);
  assert.deepEqual(pixelAt(applied, 1, 3), [20, 20, 220, 255]);
});

test("re-encoding baked pixels with original eXIf rewrites orientation to 1", () => {
  const src = fillPixels(4, 2, (x) => (x < 2 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const exif = buildExifTiff(6);
  const png = encodePng(src, { metadata: { exif } });
  const upright = decodePng(png);
  assert.equal(upright.width, 2);
  assert.equal(upright.height, 4);

  const rewritten = encodePng(upright, { metadata: { exif: withExifOrientation(exif, 1) } });
  assert.equal(exifOrientation(readImageMetadata(rewritten).exif), 1);
  const again = decodePng(rewritten);
  assert.equal(again.width, 2);
  assert.equal(again.height, 4);
  assert.deepEqual(again.data, upright.data);

  const ignored = decodePng(rewritten, { orientation: "ignore" });
  assert.deepEqual(ignored.data, upright.data);
});

test("only the first iCCP is inflated: repeated corrupt profiles cost one attempt, not one each", () => {
  const png = encodePng(fillPixels(2, 2, () => [1, 2, 3, 255]));
  const chunks = parsePngChunks(png);
  const bad = new Uint8Array([...Buffer.from("bad\0\0"), 0x78, 0x9c, 0xff, 0xff, 0xff, 0xff]);
  const good = new Uint8Array([...Buffer.from("ok\0\0"), ...deflateSync(Buffer.from("profile"))]);
  const iccps = [
    ...Array.from({ length: 1000 }, () => ({ type: "iCCP", data: bad })),
    { type: "iCCP", data: good },
  ];
  const [ihdr, ...rest] = chunks;
  assert.ok(ihdr !== undefined);
  const tagged = assemblePng([ihdr, ...iccps, ...rest]);
  // PNG allows a single iCCP; later ones are ignored rather than retried.
  assert.equal(readImageMetadata(tagged).icc, undefined);
});
