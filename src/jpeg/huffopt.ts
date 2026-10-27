import { jpegError } from "./error.ts";
import { buildEncodeTable, type HuffmanEncode } from "./huffman.ts";

/** DHT payload: code-length counts (16) plus symbols in length order. */
export type HuffDht = {
  readonly bits: Uint8Array;
  readonly vals: Uint8Array;
};

const MAX_CLEN = 32;

function bitSize(abs: number): number {
  if (abs === 0) {
    return 0;
  }
  return 32 - Math.clz32(abs);
}

/**
 * T.81 Annex K.2 / libjpeg `jpeg_gen_optimal_table`.
 * `freq` is 256 symbol counts; zero-frequency symbols are omitted.
 * A dummy symbol 256 (count 1) reserves the all-ones code.
 */
export function genOptimalTable(freq: Uint32Array): HuffDht {
  const work = new Int32Array(257);
  let any = false;
  for (let i = 0; i < 256; i++) {
    const f = freq[i] ?? 0;
    work[i] = f > 0x7fffffff ? 0x7fffffff : f;
    if (f !== 0) {
      any = true;
    }
  }
  if (!any) {
    work[0] = 1;
  }
  work[256] = 1;

  const codesize = new Int32Array(257);
  const others = new Int32Array(257);
  others.fill(-1);

  for (;;) {
    let c1 = -1;
    let v = 1_000_000_000;
    for (let i = 0; i <= 256; i++) {
      const f = work[i] ?? 0;
      if (f !== 0 && f <= v) {
        v = f;
        c1 = i;
      }
    }
    let c2 = -1;
    v = 1_000_000_000;
    for (let i = 0; i <= 256; i++) {
      if (i === c1) {
        continue;
      }
      const f = work[i] ?? 0;
      if (f !== 0 && f <= v) {
        v = f;
        c2 = i;
      }
    }
    if (c2 < 0) {
      break;
    }

    work[c1] = (work[c1] ?? 0) + (work[c2] ?? 0);
    work[c2] = 0;

    let p = c1;
    codesize[p] = (codesize[p] ?? 0) + 1;
    while ((others[p] ?? -1) >= 0) {
      p = others[p] ?? -1;
      codesize[p] = (codesize[p] ?? 0) + 1;
    }
    others[p] = c2;

    p = c2;
    codesize[p] = (codesize[p] ?? 0) + 1;
    while ((others[p] ?? -1) >= 0) {
      p = others[p] ?? -1;
      codesize[p] = (codesize[p] ?? 0) + 1;
    }
  }

  const bits32 = new Int32Array(MAX_CLEN + 1);
  for (let i = 0; i <= 256; i++) {
    const sz = codesize[i] ?? 0;
    if (sz === 0) {
      continue;
    }
    if (sz > MAX_CLEN) {
      throw jpegError("Huffman code length overflow");
    }
    bits32[sz] = (bits32[sz] ?? 0) + 1;
  }

  for (let len = MAX_CLEN; len > 16; len--) {
    while ((bits32[len] ?? 0) > 0) {
      let j = len - 2;
      while (j > 0 && (bits32[j] ?? 0) === 0) {
        j -= 1;
      }
      bits32[len] = (bits32[len] ?? 0) - 2;
      bits32[len - 1] = (bits32[len - 1] ?? 0) + 1;
      bits32[j + 1] = (bits32[j + 1] ?? 0) + 2;
      bits32[j] = (bits32[j] ?? 0) - 1;
    }
  }

  let longest = 16;
  while (longest > 0 && (bits32[longest] ?? 0) === 0) {
    longest -= 1;
  }
  if (longest > 0) {
    bits32[longest] = (bits32[longest] ?? 0) - 1;
  }

  const bits = new Uint8Array(16);
  for (let len = 1; len <= 16; len++) {
    bits[len - 1] = bits32[len] ?? 0;
  }

  const vals: number[] = [];
  for (let len = 1; len <= MAX_CLEN; len++) {
    for (let sym = 0; sym <= 255; sym++) {
      if (codesize[sym] === len) {
        vals.push(sym);
      }
    }
  }
  return { bits, vals: Uint8Array.from(vals) };
}

export function encodeTableFromFreq(freq: Uint32Array): { dht: HuffDht; encode: HuffmanEncode } {
  const dht = genOptimalTable(freq);
  return { dht, encode: buildEncodeTable(dht.bits, dht.vals) };
}

export function countDc(freq: Uint32Array, diff: number): void {
  let v = diff;
  if (v > 2047) {
    v = 2047;
  } else if (v < -2047) {
    v = -2047;
  }
  const size = bitSize(v < 0 ? -v : v);
  freq[size] = (freq[size] ?? 0) + 1;
}

export function countAc(freq: Uint32Array, zz: ArrayLike<number>): void {
  let zeros = 0;
  for (let i = 1; i < 64; i++) {
    let coef = zz[i] ?? 0;
    if (coef === 0) {
      zeros += 1;
      continue;
    }
    while (zeros >= 16) {
      freq[0xf0] = (freq[0xf0] ?? 0) + 1;
      zeros -= 16;
    }
    if (coef > 1023) {
      coef = 1023;
    } else if (coef < -1023) {
      coef = -1023;
    }
    const size = bitSize(coef < 0 ? -coef : coef);
    const sym = (zeros << 4) | size;
    freq[sym] = (freq[sym] ?? 0) + 1;
    zeros = 0;
  }
  if (zeros > 0) {
    freq[0] = (freq[0] ?? 0) + 1;
  }
}

export function additionalBits(value: number, size: number): number {
  if (size === 0) {
    return 0;
  }
  return value < 0 ? value + (1 << size) - 1 : value;
}

export function magnitudeSize(value: number): number {
  const abs = value < 0 ? -value : value;
  return bitSize(abs);
}
