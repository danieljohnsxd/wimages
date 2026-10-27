import { jpegError } from "./error.ts";

const INITIAL_CAP = 1024;

function grow(buf: Uint8Array, byteLen: number, extra: number): Uint8Array {
  const need = byteLen + extra;
  if (need <= buf.length) {
    return buf;
  }
  let cap = buf.length;
  while (cap < need) {
    cap *= 2;
  }
  const next = new Uint8Array(cap);
  next.set(buf.subarray(0, byteLen));
  return next;
}

/** Unstuffed byte sink for JPEG markers / headers. */
export class ByteWriter {
  private buf: Uint8Array = new Uint8Array(INITIAL_CAP);
  private byteLen = 0;

  writeByte(b: number): void {
    this.buf = grow(this.buf, this.byteLen, 1);
    this.buf[this.byteLen] = b & 0xff;
    this.byteLen += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.buf = grow(this.buf, this.byteLen, bytes.length);
    this.buf.set(bytes, this.byteLen);
    this.byteLen += bytes.length;
  }

  writeUint16(value: number): void {
    this.writeByte((value >>> 8) & 0xff);
    this.writeByte(value & 0xff);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.byteLen);
  }
}

/** MSB-first entropy writer with 0xFF byte stuffing. Pads leftover bits with 1s. */
export class BitWriter {
  private buf: Uint8Array = new Uint8Array(INITIAL_CAP);
  private byteLen = 0;
  private acc = 0;
  private bitCount = 0;

  writeBits(value: number, n: number): void {
    if (n <= 0) {
      return;
    }
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.bitCount += n;
    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      this.pushStuffed((this.acc >> this.bitCount) & 0xff);
      this.acc &= this.bitCount === 0 ? 0 : (1 << this.bitCount) - 1;
    }
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) {
      const byte = (this.acc << (8 - this.bitCount)) | ((1 << (8 - this.bitCount)) - 1);
      this.pushStuffed(byte & 0xff);
      this.acc = 0;
      this.bitCount = 0;
    }
    return this.buf.subarray(0, this.byteLen);
  }

  private pushStuffed(byte: number): void {
    this.buf = grow(this.buf, this.byteLen, byte === 0xff ? 2 : 1);
    this.buf[this.byteLen] = byte;
    this.byteLen += 1;
    if (byte === 0xff) {
      this.buf[this.byteLen] = 0;
      this.byteLen += 1;
    }
  }
}

/** MSB-first entropy reader. Unstuffs 0xFF00; leaves RST / other markers unread. */
export class BitReader {
  private readonly data: Uint8Array;
  private index: number;
  private acc = 0;
  private bitCount = 0;
  /** Second byte of a marker hit while filling (e.g. 0xD0). */
  private marker: number | undefined;
  /** Byte index of the 0xFF that started `marker`. */
  private markerAt: number | undefined;
  /**
   * True once the decoder asked for bits past a marker, i.e. the scan's entropy
   * data is exhausted. Those bits read as zeros (libjpeg's `insufficient_data`);
   * the scan loop stops decoding blocks so a data-less scan costs O(1), not a
   * full pass over the image.
   */
  private overrun = false;

  constructor(data: Uint8Array, offset: number) {
    this.data = data;
    this.index = offset;
  }

  /** Byte index of the next unused byte, or of a pending marker. */
  get offset(): number {
    if (this.markerAt !== undefined) {
      return this.markerAt;
    }
    return this.index;
  }

  readBit(): number {
    if (this.bitCount === 0) {
      this.acc = this.nextStuffedByte();
      this.bitCount = 8;
    }
    this.bitCount -= 1;
    return (this.acc >> this.bitCount) & 1;
  }

  readBits(n: number): number {
    if (n <= 0) {
      return 0;
    }
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | this.readBit();
    }
    return v;
  }

  get exhausted(): boolean {
    return this.overrun;
  }

  /** The pending marker byte is RSTn, i.e. the data ran short inside one restart interval. */
  get atRestart(): boolean {
    const m = this.marker;
    return m !== undefined && m >= 0xd0 && m <= 0xd7;
  }

  /** Discard leftover bits in the current byte (T.81 restart / scan end). */
  alignByte(): void {
    this.acc = 0;
    this.bitCount = 0;
  }

  /**
   * After a restart interval: byte-align, then consume RSTn (0xFFD0–0xFFD7).
   * Out-of-sequence RST is accepted. A missing RST is tolerated when the next
   * bytes look like entropy rather than another marker.
   */
  consumeRestart(): void {
    this.alignByte();
    if (this.marker !== undefined) {
      const m = this.marker;
      if (m >= 0xd0 && m <= 0xd7) {
        this.marker = undefined;
        this.markerAt = undefined;
        this.overrun = false;
        return;
      }
      throw jpegError(`expected restart marker, found 0xFF${m.toString(16).padStart(2, "0")}`);
    }

    let i = this.index;
    while (i < this.data.length && this.data[i] === 0xff) {
      const n = this.data[i + 1];
      if (n === 0xff) {
        i += 1;
        continue;
      }
      break;
    }
    const b = this.data[i];
    const n = this.data[i + 1];
    if (b !== 0xff || n === undefined) {
      return;
    }
    if (n >= 0xd0 && n <= 0xd7) {
      this.index = i + 2;
      return;
    }
    if (n === 0x00) {
      this.index = i;
      return;
    }
    throw jpegError(`expected restart marker, found 0xFF${n.toString(16).padStart(2, "0")}`);
  }

  private nextStuffedByte(): number {
    if (this.marker !== undefined) {
      this.overrun = true;
      return 0;
    }
    const start = this.index;
    const b = this.data[this.index];
    if (b === undefined) {
      throw jpegError("truncated entropy stream");
    }
    this.index += 1;
    if (b !== 0xff) {
      return b;
    }
    const n = this.data[this.index];
    if (n === undefined) {
      throw jpegError("truncated entropy stream");
    }
    this.index += 1;
    if (n === 0x00) {
      return 0xff;
    }
    this.marker = n;
    this.markerAt = start;
    this.overrun = true;
    return 0;
  }
}
