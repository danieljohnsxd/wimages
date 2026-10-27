import type { ImageMetadata } from "../metadata.ts";
import { ByteWriter } from "./bits.ts";
import {
  checkJpegBudget,
  parseSofHeader,
  precisionMessage,
  unsupportedSofMessage,
} from "./budget.ts";
import { jpegError, jpegRangeError } from "./error.ts";
import { buildExifOrientationPayload } from "./exif.ts";
import { JPEG_MAX_PAYLOAD, writeApp1, writeApp2 } from "./markers.ts";

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

const EXIF_IDENT = latin1("Exif\0\0");
const XMP_IDENT = latin1("http://ns.adobe.com/xap/1.0/\0");
const ICC_IDENT = latin1("ICC_PROFILE\0");
/** APP2 payload = ident + seq + count + data. Data per chunk is 65,519 bytes. */
const ICC_CHUNK = JPEG_MAX_PAYLOAD - ICC_IDENT.length - 2;

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  let n = 0;
  for (const p of parts) {
    n += p.length;
  }
  if (n === 0) {
    return undefined;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
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

type IccPiece = {
  readonly seq: number;
  readonly count: number;
  readonly data: Uint8Array;
};

/**
 * Reassemble ICC_PROFILE chunks by 1-based sequence. Inconsistent count,
 * duplicates, or gaps → skip the profile (do not concatenate in file order).
 */
function assembleIcc(pieces: readonly IccPiece[]): Uint8Array | undefined {
  if (pieces.length === 0) {
    return undefined;
  }
  const first = pieces[0];
  if (first === undefined) {
    return undefined;
  }
  const count = first.count;
  if (count < 1 || count > 255) {
    return undefined;
  }
  const bySeq: Array<Uint8Array | undefined> = [];
  for (const p of pieces) {
    if (p.count !== count || p.seq < 1 || p.seq > count) {
      return undefined;
    }
    if (bySeq[p.seq] !== undefined) {
      return undefined;
    }
    bySeq[p.seq] = p.data;
  }
  const ordered: Uint8Array[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const part = bySeq[seq];
    if (part === undefined) {
      return undefined;
    }
    ordered.push(part);
  }
  return concatAll(ordered);
}

function handleSof(marker: number, payload: Uint8Array, maxPixels: number | undefined): void {
  if (marker === 0xc0 || marker === 0xc2) {
    const sof = parseSofHeader(payload);
    if (sof.precision !== 8) {
      throw jpegError(precisionMessage(sof.precision));
    }
    checkJpegBudget(sof, maxPixels);
    return;
  }
  if (marker === 0xc4 || marker === 0xc8 || marker < 0xc1 || marker > 0xcf) {
    return;
  }
  const named = unsupportedSofMessage(marker);
  throw jpegError(named ?? `unsupported frame type 0xFF${marker.toString(16)}`);
}

/** Header-only: stop at SOS. Extended-XMP APP1 is skipped. */
export function readJpegMetadata(bytes: Uint8Array, maxPixels?: number): ImageMetadata {
  let pos = 2;
  let exif: Uint8Array | undefined;
  let xmp: Uint8Array | undefined;
  const iccParts: IccPiece[] = [];

  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      break;
    }
    while (pos < bytes.length && bytes[pos] === 0xff) {
      pos += 1;
    }
    if (pos >= bytes.length) {
      break;
    }
    const marker = bytes[pos];
    if (marker === undefined) {
      break;
    }
    pos += 1;
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (marker === 0x00 || marker === 0xff) {
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      continue;
    }
    if (pos + 2 > bytes.length) {
      break;
    }
    const length = ((bytes[pos] ?? 0) << 8) | (bytes[pos + 1] ?? 0);
    if (length < 2 || pos + length > bytes.length) {
      break;
    }
    const payload = bytes.subarray(pos + 2, pos + length);
    pos += length;

    if (marker === 0xe1) {
      if (exif === undefined && hasPrefix(payload, EXIF_IDENT)) {
        exif = payload.subarray(EXIF_IDENT.length);
      } else if (xmp === undefined && hasPrefix(payload, XMP_IDENT)) {
        xmp = payload.subarray(XMP_IDENT.length);
      }
    } else if (
      marker === 0xe2 &&
      hasPrefix(payload, ICC_IDENT) &&
      payload.length >= ICC_IDENT.length + 2
    ) {
      const seq = payload[ICC_IDENT.length] ?? 0;
      const count = payload[ICC_IDENT.length + 1] ?? 0;
      iccParts.push({ seq, count, data: payload.subarray(ICC_IDENT.length + 2) });
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
      handleSof(marker, payload, maxPixels);
    }
  }

  return packMetadata(exif, assembleIcc(iccParts), xmp);
}

function writeIcc(out: ByteWriter, icc: Uint8Array): void {
  const n = Math.ceil(icc.length / ICC_CHUNK);
  if (n > 255) {
    throw jpegRangeError("ICC profile is too large to store in APP2 segments");
  }
  for (let i = 0; i < n; i++) {
    const start = i * ICC_CHUNK;
    const piece = icc.subarray(start, start + ICC_CHUNK);
    const payload = new Uint8Array(ICC_IDENT.length + 2 + piece.length);
    payload.set(ICC_IDENT, 0);
    payload[ICC_IDENT.length] = i + 1;
    payload[ICC_IDENT.length + 1] = n;
    payload.set(piece, ICC_IDENT.length + 2);
    writeApp2(out, payload);
  }
}

/**
 * APP1 Exif, APP1 XMP, APP2 ICC (split at 65,519 data bytes). Empty fields are skipped.
 * EXIF/XMP payloads that do not fit in one segment throw.
 */
export function writeJpegMetadata(out: ByteWriter, metadata: ImageMetadata | undefined): void {
  if (metadata === undefined) {
    return;
  }
  const exif = metadata.exif;
  if (exif !== undefined && exif.length > 0) {
    writeApp1(out, concat2(EXIF_IDENT, exif));
  }
  const xmp = metadata.xmp;
  if (xmp !== undefined && xmp.length > 0) {
    writeApp1(out, concat2(XMP_IDENT, xmp));
  }
  const icc = metadata.icc;
  if (icc !== undefined && icc.length > 0) {
    writeIcc(out, icc);
  }
}

/**
 * Drop private metadata from a JPEG without touching the entropy-coded data:
 * APP1 (EXIF, XMP), APP3–APP13, APP15, COM, non-ICC APP2 (MPF, FlashPix) and
 * anything after EOI (MPF secondary images, gain maps, trailers). Kept: APP0
 * (JFIF), APP2 ICC_PROFILE (how pixels look), APP14 Adobe (how components
 * decode), and every table / frame / scan segment. When `orientation` is 2–8 a
 * one-tag EXIF replaces the first APP1 so the file still displays upright.
 * Returns `bytes` itself when nothing was removed.
 */
export function stripJpegMetadata(bytes: Uint8Array, orientation: number): Uint8Array {
  const out = new ByteWriter();
  out.writeBytes(bytes.subarray(0, 2));
  let pos = 2;
  let removed = false;
  let wroteOrientation = orientation < 2 || orientation > 8;
  for (;;) {
    if (bytes[pos] !== 0xff) {
      throw jpegError("expected marker");
    }
    while (bytes[pos + 1] === 0xff) {
      pos += 1;
    }
    const marker = bytes[pos + 1];
    if (marker === undefined) {
      throw jpegError("truncated");
    }
    const start = pos;
    if (marker === 0xd9) {
      out.writeBytes(bytes.subarray(start, start + 2));
      if (start + 2 < bytes.length) {
        removed = true;
      }
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.writeBytes(bytes.subarray(start, start + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > bytes.length) {
      throw jpegError("truncated segment");
    }
    const length = ((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0);
    const end = pos + 2 + length;
    if (length < 2 || end > bytes.length) {
      throw jpegError("truncated segment");
    }
    if (marker === 0xda) {
      // Copy the SOS header plus entropy data up to the next real marker.
      let i = end;
      while (i + 1 < bytes.length) {
        const next = bytes[i + 1] ?? 0;
        if (bytes[i] === 0xff && next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) {
          break;
        }
        i += 1;
      }
      if (i + 1 >= bytes.length) {
        throw jpegError("truncated entropy stream");
      }
      out.writeBytes(bytes.subarray(start, i));
      pos = i;
      continue;
    }
    const payload = bytes.subarray(pos + 4, end);
    pos = end;
    if (keepSegment(marker, payload)) {
      out.writeBytes(bytes.subarray(start, end));
      continue;
    }
    removed = true;
    if (marker === 0xe1 && !wroteOrientation) {
      writeApp1(out, buildExifOrientationPayload(orientation));
      wroteOrientation = true;
    }
  }
  return removed ? out.finish() : bytes;
}

function keepSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe2) {
    return hasPrefix(payload, ICC_IDENT);
  }
  if (marker === 0xe0 || marker === 0xee) {
    return true;
  }
  return !((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe);
}
