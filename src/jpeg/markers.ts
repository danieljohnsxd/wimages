import type { ByteWriter } from "./bits.ts";
import { jpegRangeError } from "./error.ts";
import { ZIGZAG } from "./tables.ts";

export function writeMarker(out: ByteWriter, code: number): void {
  out.writeByte(0xff);
  out.writeByte(code);
}

export function writeApp0(out: ByteWriter): void {
  writeMarker(out, 0xe0);
  out.writeUint16(16);
  out.writeByte(0x4a);
  out.writeByte(0x46);
  out.writeByte(0x49);
  out.writeByte(0x46);
  out.writeByte(0x00);
  out.writeByte(0x01);
  out.writeByte(0x01);
  out.writeByte(0x00);
  out.writeUint16(1);
  out.writeUint16(1);
  out.writeByte(0x00);
  out.writeByte(0x00);
}

/** Adobe APP14 (transform 0 = unknown/RGB/CMYK, 1 = YCbCr, 2 = YCCK). */
export function writeApp14(out: ByteWriter, transform: number): void {
  writeMarker(out, 0xee);
  out.writeUint16(14);
  out.writeByte(0x41);
  out.writeByte(0x64);
  out.writeByte(0x6f);
  out.writeByte(0x62);
  out.writeByte(0x65);
  out.writeUint16(100);
  out.writeUint16(0);
  out.writeUint16(0);
  out.writeByte(transform & 0xff);
}

/** Segment length field is 2 bytes and includes itself, so payload max is 65,533. */
export const JPEG_MAX_PAYLOAD = 65533;

function writeApp(out: ByteWriter, marker: number, payload: Uint8Array): void {
  if (payload.length > JPEG_MAX_PAYLOAD) {
    throw jpegRangeError("APP segment payload exceeds 65533 bytes");
  }
  writeMarker(out, marker);
  out.writeUint16(2 + payload.length);
  out.writeBytes(payload);
}

export function writeApp1(out: ByteWriter, payload: Uint8Array): void {
  writeApp(out, 0xe1, payload);
}

/** Copy an Adobe APP14 payload verbatim (ident + version + flags + transform). */
export function writeApp14Payload(out: ByteWriter, payload: Uint8Array): void {
  writeApp(out, 0xee, payload);
}

export function writeApp2(out: ByteWriter, payload: Uint8Array): void {
  writeApp(out, 0xe2, payload);
}

export function writeDqt(
  out: ByteWriter,
  tableId: number,
  quant: ArrayLike<number>,
  precision: 0 | 1 = 0,
): void {
  const sampleBytes = precision === 0 ? 1 : 2;
  writeMarker(out, 0xdb);
  out.writeUint16(3 + 64 * sampleBytes);
  out.writeByte((precision << 4) | (tableId & 0x0f));
  for (let i = 0; i < 64; i++) {
    const n = ZIGZAG[i] ?? 0;
    const v = quant[n] ?? 1;
    if (precision === 0) {
      out.writeByte(v);
    } else {
      out.writeUint16(v);
    }
  }
}

export type SofComponent = {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly qTable: number;
};

export function writeSof(
  out: ByteWriter,
  progressive: boolean,
  width: number,
  height: number,
  comps: readonly SofComponent[],
): void {
  writeMarker(out, progressive ? 0xc2 : 0xc0);
  out.writeUint16(8 + 3 * comps.length);
  out.writeByte(8);
  out.writeUint16(height);
  out.writeUint16(width);
  out.writeByte(comps.length);
  for (const c of comps) {
    out.writeByte(c.id);
    out.writeByte(((c.h & 0x0f) << 4) | (c.v & 0x0f));
    out.writeByte(c.qTable & 0x0f);
  }
}

export function writeHuffmanTable(
  out: ByteWriter,
  classId: number,
  bits: Uint8Array,
  vals: Uint8Array,
): void {
  writeMarker(out, 0xc4);
  out.writeUint16(19 + vals.length);
  out.writeByte(classId);
  out.writeBytes(bits);
  out.writeBytes(vals);
}

export type SosComponent = {
  readonly id: number;
  readonly dc: number;
  readonly ac: number;
};

export function writeSos(
  out: ByteWriter,
  comps: readonly SosComponent[],
  ss: number,
  se: number,
  ah: number,
  al: number,
): void {
  writeMarker(out, 0xda);
  out.writeUint16(6 + 2 * comps.length);
  out.writeByte(comps.length);
  for (const c of comps) {
    out.writeByte(c.id);
    out.writeByte(((c.dc & 0x0f) << 4) | (c.ac & 0x0f));
  }
  out.writeByte(ss);
  out.writeByte(se);
  out.writeByte(((ah & 0x0f) << 4) | (al & 0x0f));
}
