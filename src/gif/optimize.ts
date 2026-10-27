import type { DecodeLimits } from "../limits.ts";
import { decodeGif } from "./decode.ts";
import { encodeGif, type GifFrame } from "./encode.ts";
import { gifError } from "./error.ts";

export type GifOptimizeResult = {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
};

/**
 * Lossless GIF rewrite: decode once to composited RGBA, re-encode with frame
 * optimization (dirty-rect crop, transparent dedup, disposal 1/2, duplicate
 * merge). `maxPixels` is passed through to that single decode. Returns the
 * input when the rewrite is not smaller.
 */
export function optimizeGif(bytes: Uint8Array, options?: DecodeLimits): GifOptimizeResult {
  const encoded = rewriteGif(bytes, options);
  if (encoded.length < bytes.length) {
    return { bytes: encoded, changed: true };
  }
  return { bytes, changed: false };
}

/** The frame-optimized re-encode `optimizeGif` compares against the input. */
export function rewriteGif(bytes: Uint8Array, options?: DecodeLimits): Uint8Array {
  const decoded = decodeGif(bytes, options);
  return decoded.frames.length === 1 && decoded.loop === undefined
    ? encodeStill(decoded.frames[0])
    : encodeAnimation(decoded.frames, decoded.delays, decoded.loop);
}

function encodeStill(frame: GifFrame | undefined): Uint8Array {
  if (frame === undefined) {
    throw gifError("has no image data");
  }
  return encodeGif(frame);
}

function encodeAnimation(
  frames: readonly GifFrame[],
  delays: readonly number[],
  loop: number | undefined,
): Uint8Array {
  const out: GifFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) {
      continue;
    }
    const delay = delays[i] ?? 0;
    out.push({ width: frame.width, height: frame.height, data: frame.data, delay });
  }
  if (loop === undefined) {
    return encodeGif(out, { palette: "local" });
  }
  return encodeGif(out, { palette: "local", loop });
}

/** Application extensions that change playback or color, not metadata. */
const KEPT_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);

/**
 * Drop comment extensions, application extensions other than looping / ICC
 * (XMP "XMP DataXMP" and vendor blocks), and bytes after the trailer, without
 * re-encoding. Returns `bytes` itself when nothing was removed. Throws on
 * malformed structure.
 */
export function stripGifMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 13) {
    throw gifError("truncated header");
  }
  const packed = bytes[10] ?? 0;
  let pos = 13;
  if ((packed & 0x80) !== 0) {
    pos += 3 * (1 << ((packed & 7) + 1));
  }
  const parts: Uint8Array[] = [bytes.subarray(0, pos)];
  let removed = false;
  for (;;) {
    const introducer = bytes[pos];
    if (introducer === undefined) {
      break; // no trailer: decoders (and decodeGif) stop at end of data too
    }
    const start = pos;
    if (introducer === 0x3b) {
      parts.push(bytes.subarray(start, start + 1));
      if (start + 1 < bytes.length) {
        removed = true;
      }
      break;
    }
    if (introducer === 0x2c) {
      const localPacked = bytes[pos + 9];
      if (localPacked === undefined) {
        throw gifError("truncated image descriptor");
      }
      pos += 10;
      if ((localPacked & 0x80) !== 0) {
        pos += 3 * (1 << ((localPacked & 7) + 1));
      }
      pos = skipSubBlocks(bytes, pos + 1);
      parts.push(bytes.subarray(start, pos));
      continue;
    }
    if (introducer !== 0x21) {
      throw gifError("unexpected block");
    }
    const label = bytes[pos + 1];
    pos = skipSubBlocks(bytes, pos + 2);
    let keep = label !== 0xfe;
    if (label === 0xff) {
      const size = bytes[start + 2] ?? 0;
      let id = "";
      for (let i = 0; i < size && i < 11; i++) {
        id += String.fromCharCode(bytes[start + 3 + i] ?? 0);
      }
      keep = KEPT_APPLICATIONS.has(id);
    }
    if (keep) {
      parts.push(bytes.subarray(start, pos));
    } else {
      removed = true;
    }
  }
  if (!removed) {
    return bytes;
  }
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

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let pos = start;
  for (;;) {
    const n = bytes[pos];
    if (n === undefined) {
      throw gifError("truncated sub-block");
    }
    pos += 1;
    if (n === 0) {
      return pos;
    }
    pos += n;
  }
}
