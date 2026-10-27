/**
 * Test-only PNG decoder: inflate IDAT with node:zlib, unfilter, unpack to RGBA.
 * Supports color types 0, 2, 3, 4, 6 and bit depths 1, 2, 4, 8. Verifies CRC.
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = makeCrcTable();

export type PngChunk = {
  readonly type: string;
  readonly data: Uint8Array;
};

export type PngIhdr = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
};

export type DecodedPngRgba = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) {
      throw new RangeError("CRC input ended early");
    }
    const entry = CRC_TABLE[(crc ^ b) & 0xff];
    if (entry === undefined) {
      throw new RangeError("CRC table lookup failed");
    }
    crc = entry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function at(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new RangeError("unexpected end of PNG data");
  }
  return value;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((at(bytes, offset) << 24) |
      (at(bytes, offset + 1) << 16) |
      (at(bytes, offset + 2) << 8) |
      at(bytes, offset + 3)) >>>
    0
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (at(bytes, offset) << 8) | at(bytes, offset + 1);
}

function asciiType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    at(bytes, offset),
    at(bytes, offset + 1),
    at(bytes, offset + 2),
    at(bytes, offset + 3),
  );
}

function signaturesMatch(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (at(bytes, i) !== at(PNG_SIGNATURE, i)) {
      return false;
    }
  }
  return true;
}

export function writeUint32BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

export function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) {
    throw new TypeError("PNG chunk type must be exactly 4 ASCII characters");
  }
  const out = new Uint8Array(12 + data.length);
  writeUint32BE(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = pngCrc32(out.subarray(4, 8 + data.length));
  writeUint32BE(out, 8 + data.length, crc);
  return out;
}

export function assemblePng(chunks: readonly PngChunk[]): Uint8Array {
  let total = PNG_SIGNATURE.length;
  const encoded: Uint8Array[] = [];
  for (const chunk of chunks) {
    const bytes = createPngChunk(chunk.type, chunk.data);
    encoded.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  if (!signaturesMatch(bytes)) {
    throw new Error("invalid PNG signature");
  }

  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    const length = readUint32BE(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > bytes.length) {
      throw new RangeError("truncated PNG chunk");
    }
    const type = asciiType(bytes, typeStart);
    const data = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = readUint32BE(bytes, crcOffset);
    const actualCrc = pngCrc32(bytes.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`bad CRC for ${type} chunk`);
    }
    chunks.push({ type, data });
    offset = crcOffset + 4;
  }

  return chunks;
}

function firstChunk(chunks: readonly PngChunk[], type: string): PngChunk | undefined {
  for (const chunk of chunks) {
    if (chunk.type === type) {
      return chunk;
    }
  }
  return undefined;
}

function concatIdat(chunks: readonly PngChunk[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    if (chunk.type === "IDAT") {
      total += chunk.data.length;
    }
  }
  if (total === 0) {
    throw new Error("PNG has no IDAT data");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk.type === "IDAT") {
      out.set(chunk.data, offset);
      offset += chunk.data.length;
    }
  }
  return out;
}

export function readPngIhdr(bytes: Uint8Array): PngIhdr {
  const chunks = parsePngChunks(bytes);
  return parseIhdr(chunks);
}

function parseIhdr(chunks: readonly PngChunk[]): PngIhdr {
  const first = chunks[0];
  if (first === undefined || first.type !== "IHDR") {
    throw new Error("PNG must start with IHDR");
  }
  if (first.data.length !== 13) {
    throw new Error("IHDR must be 13 bytes");
  }
  const width = readUint32BE(first.data, 0);
  const height = readUint32BE(first.data, 4);
  const bitDepth = at(first.data, 8);
  const colorType = at(first.data, 9);
  const compression = at(first.data, 10);
  const filter = at(first.data, 11);
  const interlace = at(first.data, 12);
  if (compression !== 0) {
    throw new Error("unsupported PNG compression method");
  }
  if (filter !== 0) {
    throw new Error("unsupported PNG filter method");
  }
  if (interlace !== 0) {
    throw new Error("interlaced PNG is not supported in test helper");
  }
  if (width === 0 || height === 0) {
    throw new RangeError("IHDR width and height must be positive");
  }
  return { width, height, bitDepth, colorType };
}

function channelCount(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`unsupported PNG color type ${colorType}`);
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function unfilter(
  inflated: Uint8Array,
  height: number,
  lineBytes: number,
  bytesPerPixel: number,
): Uint8Array {
  const stride = 1 + lineBytes;
  if (inflated.length !== height * stride) {
    throw new Error("inflated IDAT length does not match scanlines");
  }
  const out = new Uint8Array(height * lineBytes);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const filterType = at(inflated, rowStart);
    const dest = y * lineBytes;
    for (let x = 0; x < lineBytes; x++) {
      const raw = at(inflated, rowStart + 1 + x);
      const a = x >= bytesPerPixel ? at(out, dest + x - bytesPerPixel) : 0;
      const b = y > 0 ? at(out, dest - lineBytes + x) : 0;
      const c = y > 0 && x >= bytesPerPixel ? at(out, dest - lineBytes + x - bytesPerPixel) : 0;
      let recon: number;
      switch (filterType) {
        case 0:
          recon = raw;
          break;
        case 1:
          recon = (raw + a) & 0xff;
          break;
        case 2:
          recon = (raw + b) & 0xff;
          break;
        case 3:
          recon = (raw + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          recon = (raw + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      out[dest + x] = recon;
    }
  }
  return out;
}

function scaleSample(sample: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return sample;
  }
  const max = (1 << bitDepth) - 1;
  return Math.floor((sample * 255) / max);
}

function sampleAt(row: Uint8Array, sampleIndex: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return at(row, sampleIndex);
  }
  const bitOffset = sampleIndex * bitDepth;
  const byteIndex = bitOffset >> 3;
  const shift = 8 - bitDepth - (bitOffset & 7);
  const mask = (1 << bitDepth) - 1;
  return (at(row, byteIndex) >> shift) & mask;
}

function parsePalette(plte: Uint8Array): Array<{ r: number; g: number; b: number }> {
  if (plte.length === 0 || plte.length % 3 !== 0) {
    throw new Error("PLTE length must be a non-zero multiple of 3");
  }
  const colors: Array<{ r: number; g: number; b: number }> = [];
  for (let i = 0; i < plte.length; i += 3) {
    colors.push({ r: at(plte, i), g: at(plte, i + 1), b: at(plte, i + 2) });
  }
  return colors;
}

function paletteAlphas(trns: Uint8Array | undefined, paletteLength: number): Uint8Array {
  const alphas = new Uint8Array(paletteLength);
  alphas.fill(255);
  if (trns === undefined) {
    return alphas;
  }
  const n = trns.length < paletteLength ? trns.length : paletteLength;
  for (let i = 0; i < n; i++) {
    alphas[i] = at(trns, i);
  }
  return alphas;
}

export function decodePngRgba(bytes: Uint8Array): DecodedPngRgba {
  const chunks = parsePngChunks(bytes);
  const ihdr = parseIhdr(chunks);
  const last = chunks[chunks.length - 1];
  if (last === undefined || last.type !== "IEND") {
    throw new Error("PNG must end with IEND");
  }

  const { width, height, bitDepth, colorType } = ihdr;
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  }

  const channels = channelCount(colorType);
  const bitsPerPixel = bitDepth * channels;
  const lineBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bytesPerPixel = Math.ceil(bitsPerPixel / 8);

  const plteChunk = firstChunk(chunks, "PLTE");
  const trnsChunk = firstChunk(chunks, "tRNS");
  const inflated = new Uint8Array(inflateSync(concatIdat(chunks)));
  const raw = unfilter(inflated, height, lineBytes, bytesPerPixel);
  const rgba = new Uint8Array(width * height * 4);

  if (colorType === 3) {
    if (plteChunk === undefined) {
      throw new Error("palette PNG missing PLTE");
    }
    const palette = parsePalette(plteChunk.data);
    const alphas = paletteAlphas(trnsChunk?.data, palette.length);
    for (let y = 0; y < height; y++) {
      const row = raw.subarray(y * lineBytes, (y + 1) * lineBytes);
      for (let x = 0; x < width; x++) {
        const index = sampleAt(row, x, bitDepth);
        const color = palette[index];
        const alpha = alphas[index];
        if (color === undefined || alpha === undefined) {
          throw new Error("palette index out of range");
        }
        const o = (y * width + x) * 4;
        rgba[o] = color.r;
        rgba[o + 1] = color.g;
        rgba[o + 2] = color.b;
        rgba[o + 3] = alpha;
      }
    }
    return { width, height, data: rgba };
  }

  let grayKey: number | undefined;
  let redKey: number | undefined;
  let greenKey: number | undefined;
  let blueKey: number | undefined;
  if (trnsChunk !== undefined && colorType === 0) {
    if (trnsChunk.data.length !== 2) {
      throw new Error("tRNS for grayscale must be 2 bytes");
    }
    grayKey = readUint16BE(trnsChunk.data, 0);
  }
  if (trnsChunk !== undefined && colorType === 2) {
    if (trnsChunk.data.length !== 6) {
      throw new Error("tRNS for RGB must be 6 bytes");
    }
    redKey = readUint16BE(trnsChunk.data, 0);
    greenKey = readUint16BE(trnsChunk.data, 2);
    blueKey = readUint16BE(trnsChunk.data, 4);
  }

  const samplesPerPixel = channels;
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * lineBytes, (y + 1) * lineBytes);
    for (let x = 0; x < width; x++) {
      const base = x * samplesPerPixel;
      const o = (y * width + x) * 4;
      if (colorType === 0) {
        const sample = sampleAt(row, base, bitDepth);
        const gray = scaleSample(sample, bitDepth);
        rgba[o] = gray;
        rgba[o + 1] = gray;
        rgba[o + 2] = gray;
        rgba[o + 3] = grayKey === sample ? 0 : 255;
      } else if (colorType === 2) {
        const r = scaleSample(sampleAt(row, base, bitDepth), bitDepth);
        const g = scaleSample(sampleAt(row, base + 1, bitDepth), bitDepth);
        const b = scaleSample(sampleAt(row, base + 2, bitDepth), bitDepth);
        const sr = sampleAt(row, base, bitDepth);
        const sg = sampleAt(row, base + 1, bitDepth);
        const sb = sampleAt(row, base + 2, bitDepth);
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = redKey === sr && greenKey === sg && blueKey === sb ? 0 : 255;
      } else if (colorType === 4) {
        const gray = sampleAt(row, base, bitDepth);
        const alpha = sampleAt(row, base + 1, bitDepth);
        rgba[o] = gray;
        rgba[o + 1] = gray;
        rgba[o + 2] = gray;
        rgba[o + 3] = alpha;
      } else {
        rgba[o] = sampleAt(row, base, bitDepth);
        rgba[o + 1] = sampleAt(row, base + 1, bitDepth);
        rgba[o + 2] = sampleAt(row, base + 2, bitDepth);
        rgba[o + 3] = sampleAt(row, base + 3, bitDepth);
      }
    }
  }

  return { width, height, data: rgba };
}

const ADAM7 = [
  { x0: 0, y0: 0, dx: 8, dy: 8 },
  { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 },
  { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 },
  { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 },
] as const;

function independentChannelCount(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`unsupported PNG color type ${colorType}`);
  }
}

function independentPassExtent(size: number, offset: number, step: number): number {
  if (offset >= size) {
    return 0;
  }
  return Math.ceil((size - offset) / step);
}

function packIndependentRow(
  samples: Uint8Array,
  width: number,
  channels: number,
  bitDepth: number,
): Uint8Array {
  if (bitDepth === 8) {
    return samples;
  }
  if (bitDepth === 16) {
    const out = new Uint8Array(width * channels * 2);
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] ?? 0;
      out[i * 2] = v;
      out[i * 2 + 1] = v;
    }
    return out;
  }
  const out = new Uint8Array(Math.ceil((width * bitDepth) / 8));
  const mask = (1 << bitDepth) - 1;
  let acc = 0;
  let bitsLeft = 8;
  let byteIndex = 0;
  for (let x = 0; x < width; x++) {
    const sample = (samples[x] ?? 0) & mask;
    bitsLeft -= bitDepth;
    acc |= sample << bitsLeft;
    if (bitsLeft === 0) {
      out[byteIndex] = acc;
      byteIndex += 1;
      acc = 0;
      bitsLeft = 8;
    }
  }
  if (bitsLeft !== 8) {
    out[byteIndex] = acc;
  }
  return out;
}

function filterIndependentRow(
  type: number,
  raw: Uint8Array,
  prev: Uint8Array | undefined,
  bytesPerPixel: number,
): Uint8Array {
  const out = new Uint8Array(1 + raw.length);
  out[0] = type;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i] ?? 0;
    const a = i >= bytesPerPixel ? (raw[i - bytesPerPixel] ?? 0) : 0;
    const b = prev?.[i] ?? 0;
    const c = i >= bytesPerPixel ? (prev?.[i - bytesPerPixel] ?? 0) : 0;
    let predictor = 0;
    if (type === 1) {
      predictor = a;
    } else if (type === 2) {
      predictor = b;
    } else if (type === 3) {
      predictor = (a + b) >> 1;
    } else if (type === 4) {
      predictor = paethPredictor(a, b, c);
    }
    out[i + 1] = (x - predictor) & 0xff;
  }
  return out;
}

function rgbaToSamples(
  rgba: Uint8Array,
  width: number,
  height: number,
  colorType: number,
): Uint8Array {
  const channels = independentChannelCount(colorType);
  const samples = new Uint8Array(width * height * channels);
  for (let p = 0; p < width * height; p++) {
    const r = rgba[p * 4] ?? 0;
    const g = rgba[p * 4 + 1] ?? 0;
    const b = rgba[p * 4 + 2] ?? 0;
    const a = rgba[p * 4 + 3] ?? 0;
    if (colorType === 0) {
      samples[p] = r;
    } else if (colorType === 2) {
      samples[p * 3] = r;
      samples[p * 3 + 1] = g;
      samples[p * 3 + 2] = b;
    } else if (colorType === 4) {
      samples[p * 2] = r;
      samples[p * 2 + 1] = a;
    } else if (colorType === 6) {
      samples[p * 4] = r;
      samples[p * 4 + 1] = g;
      samples[p * 4 + 2] = b;
      samples[p * 4 + 3] = a;
    } else {
      samples[p] = r;
    }
  }
  return samples;
}

function extractRectSamples(
  samples: Uint8Array,
  srcW: number,
  channels: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
): Uint8Array {
  const out = new Uint8Array(w * h * channels);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = x0 + px * dx;
      const sy = y0 + py * dy;
      const si = (sy * srcW + sx) * channels;
      const di = (py * w + px) * channels;
      for (let c = 0; c < channels; c++) {
        out[di + c] = samples[si + c] ?? 0;
      }
    }
  }
  return out;
}

export type IndependentPngOptions = {
  readonly width: number;
  readonly height: number;
  readonly colorType: 0 | 2 | 3 | 4 | 6;
  readonly bitDepth?: 1 | 2 | 4 | 8 | 16;
  readonly interlace?: 0 | 1;
  readonly filter?: 0 | 1 | 2 | 3 | 4;
  readonly rgba: Uint8Array;
  readonly plte?: Uint8Array;
  readonly trns?: Uint8Array;
  readonly extraAfterIhdr?: readonly PngChunk[];
};

/**
 * Independent PNG writer (node:zlib + a spec Paeth). Used so decode tests are
 * not tautological encodePng → decodePng loops.
 */
export function writeIndependentPng(options: IndependentPngOptions): Uint8Array {
  const bitDepth = options.bitDepth ?? 8;
  const interlace = options.interlace ?? 0;
  const filter = options.filter ?? 0;
  const colorType = options.colorType;
  const { width, height, rgba } = options;
  const channels = independentChannelCount(colorType);
  const bitsPerPixel = bitDepth * channels;
  const bytesPerPixel = Math.max(1, Math.floor(bitsPerPixel / 8));
  const samples = rgbaToSamples(rgba, width, height, colorType);

  const filteredParts: Uint8Array[] = [];
  const emitPass = (passW: number, passH: number, passSamples: Uint8Array): void => {
    let prev: Uint8Array | undefined;
    for (let y = 0; y < passH; y++) {
      const rowSamples = passSamples.subarray(y * passW * channels, (y + 1) * passW * channels);
      const packed = packIndependentRow(rowSamples, passW, channels, bitDepth);
      filteredParts.push(filterIndependentRow(filter, packed, prev, bytesPerPixel));
      prev = packed;
    }
  };

  if (interlace === 0) {
    emitPass(width, height, samples);
  } else {
    for (const pass of ADAM7) {
      const pw = independentPassExtent(width, pass.x0, pass.dx);
      const ph = independentPassExtent(height, pass.y0, pass.dy);
      if (pw === 0 || ph === 0) {
        continue;
      }
      emitPass(
        pw,
        ph,
        extractRectSamples(samples, width, channels, pass.x0, pass.y0, pw, ph, pass.dx, pass.dy),
      );
    }
  }

  let total = 0;
  for (const part of filteredParts) {
    total += part.length;
  }
  const filtered = new Uint8Array(total);
  let off = 0;
  for (const part of filteredParts) {
    filtered.set(part, off);
    off += part.length;
  }

  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;

  const chunks: PngChunk[] = [{ type: "IHDR", data: ihdr }];
  if (options.extraAfterIhdr !== undefined) {
    chunks.push(...options.extraAfterIhdr);
  }
  if (options.plte !== undefined) {
    chunks.push({ type: "PLTE", data: options.plte });
  }
  if (options.trns !== undefined) {
    chunks.push({ type: "tRNS", data: options.trns });
  }
  chunks.push({ type: "IDAT", data: new Uint8Array(deflateSync(filtered)) });
  chunks.push({ type: "IEND", data: new Uint8Array(0) });
  return assemblePng(chunks);
}

export function buildExifTiff(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  tiff[0] = 0x4d;
  tiff[1] = 0x4d;
  tiff[2] = 0;
  tiff[3] = 42;
  tiff[4] = 0;
  tiff[5] = 0;
  tiff[6] = 0;
  tiff[7] = 8;
  tiff[8] = 0;
  tiff[9] = 1;
  tiff[10] = 0x01;
  tiff[11] = 0x12;
  tiff[12] = 0;
  tiff[13] = 3;
  tiff[14] = 0;
  tiff[15] = 0;
  tiff[16] = 0;
  tiff[17] = 1;
  tiff[18] = 0;
  tiff[19] = orientation;
  return tiff;
}
