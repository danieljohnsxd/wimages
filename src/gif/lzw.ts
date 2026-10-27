/** GIF LZW: codes packed LSB-first in each byte (GIF spec Appendix F). */

import { gifError } from "./error.ts";

const MAX_CODE = 4096;

function grow(buf: Uint8Array, length: number, extra: number): Uint8Array {
  if (length + extra <= buf.length) {
    return buf;
  }
  let cap = buf.length;
  while (cap < length + extra) {
    cap *= 2;
  }
  const next = new Uint8Array(cap);
  next.set(buf.subarray(0, length));
  return next;
}

function requireMinCodeSize(minCodeSize: number): void {
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8) {
    throw gifError("LZW min code size must be an integer from 2 to 8");
  }
}

export function encodeLzw(minCodeSize: number, indexes: Uint8Array): Uint8Array {
  requireMinCodeSize(minCodeSize);

  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const dict = new Map<number, number>();

  let out: Uint8Array = new Uint8Array(256);
  let outLen = 0;
  let bitAcc = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;

  const pushByte = (b: number): void => {
    out = grow(out, outLen, 1);
    out[outLen] = b;
    outLen += 1;
  };

  const writeCode = (code: number): void => {
    bitAcc |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      pushByte(bitAcc & 0xff);
      bitAcc >>>= 8;
      bitCount -= 8;
    }
  };

  const resetTable = (): void => {
    dict.clear();
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  writeCode(clearCode);
  if (indexes.length === 0) {
    writeCode(eoiCode);
    if (bitCount > 0) {
      pushByte(bitAcc & 0xff);
    }
    return out.subarray(0, outLen);
  }

  let prefix = indexes[0] ?? 0;
  for (let i = 1; i < indexes.length; i++) {
    const k = indexes[i] ?? 0;
    const key = (prefix << 8) | k;
    const existing = dict.get(key);
    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    writeCode(prefix);
    if (nextCode < MAX_CODE) {
      dict.set(key, nextCode);
      // Encoder is one entry ahead of the decoder; grow width when assigning 2^n.
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
      nextCode += 1;
      if (nextCode >= MAX_CODE) {
        writeCode(clearCode);
        resetTable();
      }
    } else {
      writeCode(clearCode);
      resetTable();
    }
    prefix = k;
  }

  writeCode(prefix);
  // Decoder adds an entry for this last prefix, which may land on 2^n and
  // widen the code before EOI. Emit EOI at that width.
  if (nextCode === 1 << codeSize && codeSize < 12) {
    codeSize += 1;
  }
  writeCode(eoiCode);
  if (bitCount > 0) {
    pushByte(bitAcc & 0xff);
  }
  return out.subarray(0, outLen);
}

/**
 * Decode a GIF LZW index stream. `maxOutput` is the frame rectangle (`width * height`);
 * the decoder never writes past it. Extra indexes throw `"GIF: LZW data exceeds frame size"`.
 * Codes above the next available slot are errors; the KwKwK (`code === next`) case is valid.
 */
export function decodeLzw(minCodeSize: number, bytes: Uint8Array, maxOutput: number): Uint8Array {
  requireMinCodeSize(minCodeSize);
  if (!Number.isInteger(maxOutput) || maxOutput <= 0) {
    throw gifError("LZW maxOutput must be a positive integer");
  }

  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const prefix = new Int16Array(MAX_CODE);
  const suffix = new Uint8Array(MAX_CODE);
  const stack = new Uint8Array(MAX_CODE);

  let pos = 0;
  let acc = 0;
  let nbits = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let prev = -1;

  const readCode = (): number => {
    while (nbits < codeSize) {
      const byte = bytes[pos];
      if (byte === undefined) {
        throw gifError("unexpected end of LZW data");
      }
      acc |= byte << nbits;
      nbits += 8;
      pos += 1;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    nbits -= codeSize;
    return code;
  };

  const initTable = (): void => {
    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1;
      suffix[i] = i;
    }
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
    prev = -1;
  };

  const out = new Uint8Array(maxOutput);
  let outLen = 0;

  const pushIndex = (value: number): void => {
    if (outLen >= maxOutput) {
      throw gifError("LZW data exceeds frame size");
    }
    out[outLen] = value;
    outLen += 1;
  };

  const emitCode = (code: number): number => {
    let c = code;
    let sp = 0;
    for (;;) {
      if (sp >= MAX_CODE) {
        throw gifError("invalid LZW code");
      }
      const p = prefix[c] ?? -1;
      if (p < 0) {
        break;
      }
      stack[sp] = suffix[c] ?? 0;
      sp += 1;
      c = p;
    }
    const first = suffix[c] ?? 0;
    pushIndex(first);
    while (sp > 0) {
      sp -= 1;
      pushIndex(stack[sp] ?? 0);
    }
    return first;
  };

  const addEntry = (first: number): void => {
    if (prev < 0 || nextCode >= MAX_CODE) {
      return;
    }
    prefix[nextCode] = prev;
    suffix[nextCode] = first;
    nextCode += 1;
    if (nextCode === 1 << codeSize && codeSize < 12) {
      codeSize += 1;
    }
  };

  initTable();

  for (;;) {
    const code = readCode();
    if (code === eoiCode) {
      break;
    }
    if (code === clearCode) {
      initTable();
      continue;
    }

    if (prev < 0) {
      if (code >= clearCode) {
        throw gifError("invalid LZW code");
      }
      emitCode(code);
      prev = code;
      continue;
    }

    let first: number;
    if (code < nextCode) {
      first = emitCode(code);
    } else if (code === nextCode) {
      // Classic KwKwK: the code is the next slot, i.e. previous string + its first byte.
      first = emitCode(prev);
      pushIndex(first);
    } else {
      throw gifError("invalid LZW code");
    }

    addEntry(first);
    prev = code;
  }

  return out.subarray(0, outLen);
}
