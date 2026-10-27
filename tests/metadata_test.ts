import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPixelBuffer,
  decodeJpeg,
  encodeJpeg,
  encodePng,
  exifOrientation,
  readImageMetadata,
  transcodeJpeg,
  withExifOrientation,
} from "../dist/index.js";
import type { ImageMetadata, PixelBuffer } from "../dist/index.js";
import { buildExifOrientationPayload } from "../src/jpeg/exif.ts";
import { parsePngChunks } from "../src/png/chunk.ts";

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

function tinyImage(): PixelBuffer {
  return fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
}

function patternBytes(length: number, salt: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 7 + salt) & 0xff;
  }
  return out;
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function tiffFromApp1(app1: Uint8Array): Uint8Array {
  return app1.subarray(6);
}

function buildLeExifTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  tiff[2] = 42;
  tiff[3] = 0;
  tiff[4] = 8;
  tiff[5] = 0;
  tiff[6] = 0;
  tiff[7] = 0;
  tiff[8] = 1;
  tiff[9] = 0;
  tiff[10] = 0x12;
  tiff[11] = 0x01;
  tiff[12] = 3;
  tiff[13] = 0;
  tiff[14] = 1;
  tiff[15] = 0;
  tiff[16] = 0;
  tiff[17] = 0;
  tiff[18] = orientation;
  tiff[19] = 0;
  return tiff;
}

function makeApp1(payload: Uint8Array): Uint8Array {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  const len = payload.length + 2;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

function spliceAfterSoi(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

function countJpegMarker(bytes: Uint8Array, code: number): number {
  let n = 0;
  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === undefined || m === 0x00 || m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xda || m === 0xd9) {
      return n;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === code) {
      n += 1;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return n;
}

function assertMetaEqual(a: ImageMetadata, b: ImageMetadata, label: string): void {
  assert.deepEqual(a.exif, b.exif, `${label} exif`);
  assert.deepEqual(a.icc, b.icc, `${label} icc`);
  assert.deepEqual(a.xmp, b.xmp, `${label} xmp`);
}

function assertOnlyOrientationBytesChanged(before: Uint8Array, after: Uint8Array): void {
  assert.equal(after.length, before.length);
  const diffs: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (after[i] !== before[i]) {
      diffs.push(i);
    }
  }
  // IFD0 SHORT 0x0112 value occupies two bytes (high byte stays 0 when 6→1).
  assert.ok(diffs.length >= 1 && diffs.length <= 2, `diff offsets ${diffs.join(",")}`);
  for (const i of diffs) {
    assert.ok(i >= 18 && i <= 19, `unexpected diff at ${i}`);
  }
}

const SAMPLE_XMP = ascii(
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
);

test("GIF and unknown bytes have no metadata", () => {
  assert.deepEqual(readImageMetadata(ascii("GIF89a....")), {});
  assert.deepEqual(readImageMetadata(ascii("not an image")), {});
  assert.deepEqual(readImageMetadata(new Uint8Array()), {});
});

test("exifOrientation is 1 when absent or invalid", () => {
  assert.equal(exifOrientation(undefined), 1);
  assert.equal(exifOrientation(new Uint8Array([1, 2, 3])), 1);
  assert.equal(exifOrientation(ascii("MM")), 1);
});

test("encodeJpeg round-trips EXIF, ICC, and XMP", () => {
  const img = tinyImage();
  const exif = tiffFromApp1(buildExifOrientationPayload(3));
  const icc = patternBytes(1024, 11);
  const metadata = { exif, icc, xmp: SAMPLE_XMP };
  const jpeg = encodeJpeg(img, { quality: 90, chroma: "4:4:4", metadata });
  const read = readImageMetadata(jpeg);
  assertMetaEqual(read, metadata, "jpeg roundtrip");
  const decoded = decodeJpeg(jpeg, { orientation: "ignore" });
  assert.equal(decoded.width, img.width);
  assert.equal(decoded.height, img.height);
});

test("encodePng round-trips EXIF, ICC, and XMP", () => {
  const img = tinyImage();
  const exif = tiffFromApp1(buildExifOrientationPayload(8));
  const icc = patternBytes(2048, 3);
  const metadata = { exif, icc, xmp: SAMPLE_XMP };
  const png = encodePng(img, { effort: "fast", metadata });
  const read = readImageMetadata(png);
  assertMetaEqual(read, metadata, "png roundtrip");
});

test("JPEG ICC larger than 65519 bytes is split across APP2 segments", () => {
  const img = tinyImage();
  const icc = patternBytes(70_000, 9);
  const jpeg = encodeJpeg(img, { quality: 50, metadata: { icc } });
  assert.equal(countJpegMarker(jpeg, 0xe2), 2);
  const read = readImageMetadata(jpeg);
  assert.deepEqual(read.icc, icc);
});

type JpegSeg = { readonly marker: number; readonly start: number; readonly end: number };

function jpegSegments(bytes: Uint8Array): JpegSeg[] {
  const segs: JpegSeg[] = [];
  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === undefined || m === 0x00 || m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xda || m === 0xd9) {
      break;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    segs.push({ marker: m, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return segs;
}

function rebuildWithApp2Order(jpeg: Uint8Array, app2: readonly Uint8Array[]): Uint8Array {
  const segs = jpegSegments(jpeg);
  const app2Segs = segs.filter((s) => s.marker === 0xe2);
  assert.equal(app2Segs.length, app2.length);
  const first = app2Segs[0];
  const last = app2Segs[app2Segs.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("no APP2");
  }
  let n = first.start + (jpeg.length - last.end);
  for (const p of app2) {
    n += p.length;
  }
  const out = new Uint8Array(n);
  out.set(jpeg.subarray(0, first.start), 0);
  let o = first.start;
  for (const p of app2) {
    out.set(p, o);
    o += p.length;
  }
  out.set(jpeg.subarray(last.end), o);
  return out;
}

function copySeg(jpeg: Uint8Array, seg: JpegSeg): Uint8Array {
  return jpeg.subarray(seg.start, seg.end);
}

test("JPEG ICC APP2 chunks are reassembled by sequence, not file order", () => {
  const icc = patternBytes(70_000, 9);
  const jpeg = encodeJpeg(tinyImage(), { quality: 50, metadata: { icc } });
  const segs = jpegSegments(jpeg).filter((s) => s.marker === 0xe2);
  assert.equal(segs.length, 2);
  const a = copySeg(jpeg, segs[0] ?? { marker: 0, start: 0, end: 0 });
  const b = copySeg(jpeg, segs[1] ?? { marker: 0, start: 0, end: 0 });
  const ident = "ICC_PROFILE\0".length;
  assert.equal(a[4 + ident], 1);
  assert.equal(b[4 + ident], 2);
  const reversed = rebuildWithApp2Order(jpeg, [b, a]);
  const firstRev = jpegSegments(reversed).find((s) => s.marker === 0xe2);
  assert.ok(firstRev !== undefined);
  assert.equal(reversed[firstRev.start + 4 + ident], 2);
  const read = readImageMetadata(reversed);
  assert.deepEqual(read.icc, icc);
});

test("malformed JPEG ICC sets (gapped seq / inconsistent count) are skipped", () => {
  const icc = patternBytes(70_000, 9);
  const jpeg = encodeJpeg(tinyImage(), { quality: 50, metadata: { icc } });
  const segs = jpegSegments(jpeg).filter((s) => s.marker === 0xe2);
  const a = new Uint8Array(copySeg(jpeg, segs[0] ?? { marker: 0, start: 0, end: 0 }));
  const b = new Uint8Array(copySeg(jpeg, segs[1] ?? { marker: 0, start: 0, end: 0 }));
  const ident = "ICC_PROFILE\0".length;
  const countOff = 4 + ident + 1;
  b[countOff] = 3;
  const inconsistent = rebuildWithApp2Order(jpeg, [a, b]);
  assert.equal(readImageMetadata(inconsistent).icc, undefined);

  const dup = new Uint8Array(a);
  const gapped = rebuildWithApp2Order(jpeg, [a, dup]);
  assert.equal(readImageMetadata(gapped).icc, undefined);
});

test("readImageMetadata rejects a 23-byte 16384×16384 SOF bomb", () => {
  const bytes = Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    8,
    0x40,
    0x00,
    0x40,
    0x00,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    0,
    3,
    0x11,
    0,
    0xff,
    0xd9,
  );
  assert.throws(() => readImageMetadata(bytes), /JPEG: .*maxPixels/);
});

test("PNG round-trips a 100 KB XMP packet", () => {
  const img = tinyImage();
  const xmp = patternBytes(100_000, 5);
  const png = encodePng(img, { effort: "fast", metadata: { xmp } });
  const read = readImageMetadata(png);
  assert.deepEqual(read.xmp, xmp);
});

test("PNG writes iCCP before PLTE and all metadata before IDAT", () => {
  const img = fillPixels(4, 4, (x, y) => [(x * 80) & 255, (y * 80) & 255, 40, 255]);
  const png = encodePng(img, {
    colorType: "palette",
    maxColors: 8,
    effort: "fast",
    metadata: {
      icc: patternBytes(64, 1),
      exif: tiffFromApp1(buildExifOrientationPayload(1)),
      xmp: SAMPLE_XMP,
    },
  });
  const types = parsePngChunks(png).map((c) => c.type);
  const ihdr = types.indexOf("IHDR");
  const iccp = types.indexOf("iCCP");
  const plte = types.indexOf("PLTE");
  const exif = types.indexOf("eXIf");
  const itxt = types.indexOf("iTXt");
  const idat = types.indexOf("IDAT");
  assert.ok(ihdr === 0);
  assert.ok(iccp > ihdr && iccp < plte);
  assert.ok(exif > ihdr && exif < idat);
  assert.ok(itxt > ihdr && itxt < idat);
  assert.ok(plte < idat);
});

test("withExifOrientation patches two bytes and decodeJpeg is not rotated", () => {
  const app1 = buildExifOrientationPayload(6);
  const tiff = tiffFromApp1(app1);
  assert.equal(exifOrientation(tiff), 6);
  const patched = withExifOrientation(tiff, 1);
  assert.equal(exifOrientation(patched), 1);
  assertOnlyOrientationBytesChanged(tiff, patched);

  const img = tinyImage();
  const jpeg = encodeJpeg(img, {
    quality: 95,
    chroma: "4:4:4",
    metadata: { exif: patched },
  });
  const decoded = decodeJpeg(jpeg);
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 4);
  const ignored = decodeJpeg(jpeg, { orientation: "ignore" });
  assert.deepEqual(decoded.data, ignored.data);
});

test("withExifOrientation handles little-endian TIFF and leaves missing tags unchanged", () => {
  const le = buildLeExifTiff(6);
  const patched = withExifOrientation(le, 1);
  assert.equal(exifOrientation(patched), 1);
  assertOnlyOrientationBytesChanged(le, patched);

  const noTag = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00]);
  assert.equal(withExifOrientation(noTag, 3), noTag);
  assert.throws(() => withExifOrientation(le, 0), RangeError);
  assert.throws(() => withExifOrientation(le, 9), RangeError);
});

test("transcodeJpeg with read metadata keeps EXIF and ICC bytes identical", () => {
  const img = tinyImage();
  const exif = tiffFromApp1(buildExifOrientationPayload(6));
  const icc = patternBytes(800, 2);
  const fixture = encodeJpeg(img, { quality: 80, chroma: "4:4:4", metadata: { exif, icc } });
  const kept = transcodeJpeg(fixture, { metadata: readImageMetadata(fixture) });
  assertMetaEqual(readImageMetadata(kept), readImageMetadata(fixture), "transcode keep");
  assert.deepEqual(readImageMetadata(kept).exif, exif);
  assert.deepEqual(readImageMetadata(kept).icc, icc);
});

test("transcodeJpeg strips ICC/XMP by default and re-emits orientation", () => {
  const img = tinyImage();
  const exif = tiffFromApp1(buildExifOrientationPayload(6));
  const fixture = encodeJpeg(img, {
    quality: 80,
    metadata: { exif, icc: patternBytes(32, 4), xmp: SAMPLE_XMP },
  });
  const stripped = transcodeJpeg(fixture);
  const meta = readImageMetadata(stripped);
  assert.equal(meta.icc, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(exifOrientation(meta.exif), 6);
});

test("JPEG EXIF and XMP that do not fit in one APP1 throw", () => {
  const img = tinyImage();
  const hugeExif = new Uint8Array(65_528);
  hugeExif[0] = 0x4d;
  hugeExif[1] = 0x4d;
  assert.throws(() => encodeJpeg(img, { metadata: { exif: hugeExif } }), /65533/);
  const hugeXmp = new Uint8Array(65_505);
  assert.throws(() => encodeJpeg(img, { metadata: { xmp: hugeXmp } }), /65533/);
});

test("extended XMP APP1 is skipped", () => {
  const img = tinyImage();
  const jpeg = encodeJpeg(img, { quality: 50, metadata: { xmp: SAMPLE_XMP } });
  const ext = ascii("http://ns.adobe.com/xmp/extension/\0");
  const withExt = spliceAfterSoi(jpeg, makeApp1(ext));
  const meta = readImageMetadata(withExt);
  assert.deepEqual(meta.xmp, SAMPLE_XMP);
});
