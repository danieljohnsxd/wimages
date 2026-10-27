/**
 * EXIF / ICC / XMP as raw payloads. Format wrappers (JPEG APP prefixes, PNG
 * chunk types) are added and stripped at the codec boundary.
 *
 * This module is codec-free (no PNG inflater, no JPEG marker walk) so JPEG-only
 * and PNG-only entry points can import the type and TIFF helpers without pulling
 * the other codec. Format readers live in `jpeg/metadata.ts` / `png/metadata.ts`;
 * the sniffing dispatcher is `readImageMetadata` in `image.ts`.
 */

export type ImageMetadata = {
  /** TIFF payload (starts with "II*\0" or "MM\0*"), i.e. JPEG APP1 minus the "Exif\0\0" prefix / PNG eXIf chunk data. */
  readonly exif?: Uint8Array;
  /** Raw ICC profile bytes (JPEG APP2 "ICC_PROFILE\0" chunks concatenated in order / PNG iCCP inflated). */
  readonly icc?: Uint8Array;
  /** XMP packet bytes (JPEG APP1 "http://ns.adobe.com/xap/1.0/\0" / PNG iTXt "XML:com.adobe.xmp"). Extended-XMP (APP1 with the /xmp/extension/ namespace) is out of scope: skip it. */
  readonly xmp?: Uint8Array;
};

const TAG_ORIENTATION = 0x0112;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

type OrientationField = {
  readonly offset: number;
  readonly size: 2 | 4;
  readonly le: boolean;
  readonly value: number;
};

function u8(data: Uint8Array, i: number): number | undefined {
  return data[i];
}

function u16(data: Uint8Array, i: number, le: boolean): number | undefined {
  const a = u8(data, i);
  const b = u8(data, i + 1);
  if (a === undefined || b === undefined) {
    return undefined;
  }
  return le ? a | (b << 8) : (a << 8) | b;
}

function u32(data: Uint8Array, i: number, le: boolean): number | undefined {
  const a = u16(data, i, le);
  const b = u16(data, i + 2, le);
  if (a === undefined || b === undefined) {
    return undefined;
  }
  return le ? a + b * 0x10000 : a * 0x10000 + b;
}

function findOrientationField(tiff: Uint8Array): OrientationField | undefined {
  const b0 = tiff[0];
  const b1 = tiff[1];
  const le = b0 === 0x49 && b1 === 0x49;
  const be = b0 === 0x4d && b1 === 0x4d;
  if (!le && !be) {
    return undefined;
  }
  if (u16(tiff, 2, le) !== 42) {
    return undefined;
  }
  const ifd0 = u32(tiff, 4, le);
  if (ifd0 === undefined || ifd0 + 2 > tiff.length) {
    return undefined;
  }
  const count = u16(tiff, ifd0, le);
  if (count === undefined) {
    return undefined;
  }
  for (let e = 0; e < count; e++) {
    const off = ifd0 + 2 + e * 12;
    if (off + 12 > tiff.length) {
      break;
    }
    if (u16(tiff, off, le) !== TAG_ORIENTATION) {
      continue;
    }
    const type = u16(tiff, off + 2, le);
    const cnt = u32(tiff, off + 4, le);
    if (cnt !== 1) {
      return undefined;
    }
    if (type === TYPE_SHORT) {
      const value = u16(tiff, off + 8, le);
      if (value === undefined) {
        return undefined;
      }
      return { offset: off + 8, size: 2, le, value };
    }
    if (type === TYPE_LONG) {
      const value = u32(tiff, off + 8, le);
      if (value === undefined) {
        return undefined;
      }
      return { offset: off + 8, size: 4, le, value };
    }
    return undefined;
  }
  return undefined;
}

function writeInt(buf: Uint8Array, offset: number, size: 2 | 4, le: boolean, value: number): void {
  if (size === 2) {
    if (le) {
      buf[offset] = value & 0xff;
      buf[offset + 1] = (value >> 8) & 0xff;
    } else {
      buf[offset] = (value >> 8) & 0xff;
      buf[offset + 1] = value & 0xff;
    }
    return;
  }
  if (le) {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >> 8) & 0xff;
    buf[offset + 2] = (value >> 16) & 0xff;
    buf[offset + 3] = (value >>> 24) & 0xff;
  } else {
    buf[offset] = (value >>> 24) & 0xff;
    buf[offset + 1] = (value >> 16) & 0xff;
    buf[offset + 2] = (value >> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
  }
}

/** IFD0 tag 0x0112. Returns 1 when `exif` is absent or the tag is missing/invalid. */
export function exifOrientation(exif: Uint8Array | undefined): number {
  if (exif === undefined) {
    return 1;
  }
  const field = findOrientationField(exif);
  if (field === undefined || field.value < 1 || field.value > 8) {
    return 1;
  }
  return field.value;
}

/**
 * Copy of `exif` with IFD0 tag 0x0112 set (both byte orders). If the tag is
 * absent, returns the input unchanged.
 */
export function withExifOrientation(exif: Uint8Array, orientation: number): Uint8Array {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw new RangeError("EXIF orientation must be an integer from 1 to 8");
  }
  const field = findOrientationField(exif);
  if (field === undefined) {
    return exif;
  }
  const out = new Uint8Array(exif);
  writeInt(out, field.offset, field.size, field.le, orientation);
  return out;
}
