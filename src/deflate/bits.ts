const INITIAL_CAP = 1024;

/** LSB-first bit writer for RFC 1951 deflate streams. */
export class BitWriter {
  private buf: Uint8Array = new Uint8Array(INITIAL_CAP);
  private byteLen = 0;
  private bitAcc = 0;
  private bitCount = 0;

  writeBits(value: number, n: number): void {
    this.bitAcc |= (value & ((1 << n) - 1)) << this.bitCount;
    this.bitCount += n;
    while (this.bitCount >= 8) {
      this.pushByte(this.bitAcc & 0xff);
      this.bitAcc >>>= 8;
      this.bitCount -= 8;
    }
  }

  writeBytes(bytes: Uint8Array): void {
    this.alignToByte();
    this.ensure(bytes.length);
    this.buf.set(bytes, this.byteLen);
    this.byteLen += bytes.length;
  }

  writeUint16LE(value: number): void {
    this.alignToByte();
    this.pushByte(value & 0xff);
    this.pushByte((value >>> 8) & 0xff);
  }

  alignToByte(): void {
    if (this.bitCount > 0) {
      this.pushByte(this.bitAcc & 0xff);
      this.bitAcc = 0;
      this.bitCount = 0;
    }
  }

  finish(): Uint8Array {
    this.alignToByte();
    return this.buf.subarray(0, this.byteLen);
  }

  private pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.byteLen] = b;
    this.byteLen += 1;
  }

  private ensure(extra: number): void {
    const need = this.byteLen + extra;
    if (need <= this.buf.length) {
      return;
    }
    let cap = this.buf.length;
    while (cap < need) {
      cap *= 2;
    }
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.byteLen));
    this.buf = next;
  }
}

/** Reverse `len` bits of `code` so Huffman MSB is written first on an LSB stream. */
export function reverseBits(code: number, len: number): number {
  let rev = 0;
  let c = code;
  for (let i = 0; i < len; i++) {
    rev = (rev << 1) | (c & 1);
    c >>>= 1;
  }
  return rev;
}
