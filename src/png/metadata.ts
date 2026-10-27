import { zlibDeflate, zlibInflate } from "../deflate/zlib.ts";
import type { ImageMetadata } from "../metadata.ts";
import { concatBytes, createChunk, parsePngChunks } from "./chunk.ts";

const XMP_KEYWORD = "XML:com.adobe.xmp";
const ICC_NAME = "ICC profile";
/** Inflated iCCP / iTXt / zTXt cap: a zip-bomb chunk must not allocate unbounded. */
const MAX_TEXT = 16 * 1024 * 1024;
/** Compress iTXt XMP when the packet is at least this many bytes. */
const XMP_COMPRESS_AT = 4096;

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

const XMP_KEYWORD_BYTES = latin1(XMP_KEYWORD);

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function nullAt(data: Uint8Array, start: number): number | undefined {
  for (let i = start; i < data.length; i++) {
    if (data[i] === 0) {
      return i;
    }
  }
  return undefined;
}

function inflateAncillary(compressed: Uint8Array): Uint8Array | undefined {
  if (compressed.length < 6) {
    return undefined;
  }
  try {
    return zlibInflate(compressed, 0, MAX_TEXT);
  } catch {
    return undefined;
  }
}

function buildIccp(icc: Uint8Array): Uint8Array {
  const name = latin1(ICC_NAME);
  const compressed = zlibDeflate(icc);
  const out = new Uint8Array(name.length + 2 + compressed.length);
  out.set(name, 0);
  out[name.length] = 0;
  out[name.length + 1] = 0;
  out.set(compressed, name.length + 2);
  return out;
}

function buildXmpItxt(xmp: Uint8Array): Uint8Array {
  const keyword = latin1(XMP_KEYWORD);
  if (xmp.length < XMP_COMPRESS_AT) {
    // keyword\0, flag 0, method 0, empty language\0, empty translated keyword\0, text
    return concatBytes([keyword, new Uint8Array([0, 0, 0, 0, 0]), xmp]);
  }
  const compressed = zlibDeflate(xmp);
  return concatBytes([keyword, new Uint8Array([0, 1, 0, 0, 0]), compressed]);
}

/** iCCP, eXIf, iTXt — safe to insert after IHDR and before PLTE/IDAT. */
export function pngMetadataChunks(metadata: ImageMetadata | undefined): Uint8Array[] {
  if (metadata === undefined) {
    return [];
  }
  const chunks: Uint8Array[] = [];
  const icc = metadata.icc;
  if (icc !== undefined && icc.length > 0) {
    chunks.push(createChunk("iCCP", buildIccp(icc)));
  }
  const exif = metadata.exif;
  if (exif !== undefined && exif.length > 0) {
    chunks.push(createChunk("eXIf", exif));
  }
  const xmp = metadata.xmp;
  if (xmp !== undefined && xmp.length > 0) {
    chunks.push(createChunk("iTXt", buildXmpItxt(xmp)));
  }
  return chunks;
}

function parseIccp(data: Uint8Array): Uint8Array | undefined {
  const nameEnd = nullAt(data, 0);
  if (nameEnd === undefined || nameEnd < 1 || nameEnd > 79) {
    return undefined;
  }
  if (data[nameEnd + 1] !== 0) {
    return undefined;
  }
  return inflateAncillary(data.subarray(nameEnd + 2));
}

function parseXmpItxt(data: Uint8Array): Uint8Array | undefined {
  const keyEnd = nullAt(data, 0);
  if (keyEnd === undefined || !equalBytes(data.subarray(0, keyEnd), XMP_KEYWORD_BYTES)) {
    return undefined;
  }
  const flag = data[keyEnd + 1];
  const method = data[keyEnd + 2];
  if ((flag !== 0 && flag !== 1) || method !== 0) {
    return undefined;
  }
  const langEnd = nullAt(data, keyEnd + 3);
  if (langEnd === undefined) {
    return undefined;
  }
  const transEnd = nullAt(data, langEnd + 1);
  if (transEnd === undefined) {
    return undefined;
  }
  const text = data.subarray(transEnd + 1);
  if (flag === 0) {
    return text;
  }
  return inflateAncillary(text);
}

function packMetadata(
  exif: Uint8Array | undefined,
  icc: Uint8Array | undefined,
  xmp: Uint8Array | undefined,
): ImageMetadata {
  const out: { exif?: Uint8Array; icc?: Uint8Array; xmp?: Uint8Array } = {};
  if (exif !== undefined && exif.length > 0) {
    out.exif = exif;
  }
  if (icc !== undefined && icc.length > 0) {
    out.icc = icc;
  }
  if (xmp !== undefined && xmp.length > 0) {
    out.xmp = xmp;
  }
  return out;
}

/**
 * Walks until IEND (parsePngChunks). Ancillary CRC failures are already skipped.
 * Only the first iCCP is inflated (PNG allows one), and XMP is skipped unless
 * asked for: both inflate up to 16 MB.
 */
export function readPngMetadata(bytes: Uint8Array): ImageMetadata {
  return readPngMetadataFields(bytes, true);
}

export function readPngMetadataFields(bytes: Uint8Array, includeXmp: boolean): ImageMetadata {
  const chunks = parsePngChunks(bytes);
  let exif: Uint8Array | undefined;
  let icc: Uint8Array | undefined;
  let xmp: Uint8Array | undefined;
  let sawIccp = false;
  let sawXmp = !includeXmp;
  for (const chunk of chunks) {
    if (chunk.type === "eXIf" && exif === undefined) {
      exif = chunk.data;
    } else if (chunk.type === "iCCP" && !sawIccp) {
      sawIccp = true;
      icc = parseIccp(chunk.data);
    } else if (chunk.type === "iTXt" && !sawXmp && isXmpItxt(chunk.data)) {
      sawXmp = true;
      xmp = parseXmpItxt(chunk.data);
    }
  }
  return packMetadata(exif, icc, xmp);
}

function isXmpItxt(data: Uint8Array): boolean {
  const keyEnd = nullAt(data, 0);
  return keyEnd !== undefined && equalBytes(data.subarray(0, keyEnd), XMP_KEYWORD_BYTES);
}

/** Chunks that carry text or camera metadata (EXIF GPS, comments, XMP, timestamps). */
const PRIVATE_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/**
 * Drop private metadata chunks without re-encoding: eXIf, tEXt, zTXt, iTXt,
 * tIME, and anything after IEND. iCCP, gAMA/cHRM/sRGB, pHYs and APNG chunks are
 * kept. When `orientation` is 2–8 a one-tag eXIf replaces the original so the
 * file still displays upright. Returns `bytes` itself when nothing was removed.
 */
export function stripPngMetadata(
  bytes: Uint8Array,
  orientationExif: Uint8Array | undefined,
): Uint8Array {
  const chunks = parsePngChunks(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let removed = false;
  let total = 8;
  let wroteOrientation = orientationExif === undefined;
  for (const chunk of chunks) {
    total += chunk.data.length + 12;
    if (PRIVATE_CHUNKS.has(chunk.type)) {
      removed = true;
      if (chunk.type === "eXIf" && !wroteOrientation && orientationExif !== undefined) {
        parts.push(createChunk("eXIf", orientationExif));
        wroteOrientation = true;
      }
      continue;
    }
    parts.push(createChunk(chunk.type, chunk.data));
  }
  // parsePngChunks drops bad-CRC ancillary chunks and bytes after IEND.
  if (!removed && total === bytes.length) {
    return bytes;
  }
  return concatBytes(parts);
}
