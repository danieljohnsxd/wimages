import type { ImageMetadata } from "../metadata.ts";
import { ByteWriter } from "./bits.ts";
import {
  decodeJpegCoefficients,
  type JpegCoeffComponent,
  type JpegCoefficients,
  type JpegQuantTable,
} from "./decode.ts";
import { jpegError, jpegRangeError } from "./error.ts";
import { buildExifOrientationPayload } from "./exif.ts";
import {
  writeApp0,
  writeApp1,
  writeApp14,
  writeApp14Payload,
  writeDqt,
  writeMarker,
  writeSof,
  type SofComponent,
} from "./markers.ts";
import { writeJpegMetadata } from "./metadata.ts";
import {
  encodeProgressiveScans,
  encodeSequentialScans,
  progressiveScansFor,
  type ComponentCoeffs,
} from "./scan.ts";

export type JpegTranscodeOptions = {
  /** Emit SOF2 with the libjpeg-turbo scan script (gray variant for 1 component). Default false = baseline SOF0. */
  readonly progressive?: boolean;
  /**
   * APP segments to write after APP0 (JFIF). Default: strip every APP/COM segment.
   * When `exif` is omitted and the source orientation is not 1, a one-tag EXIF APP1
   * is still emitted so the file displays upright.
   */
  readonly metadata?: ImageMetadata;
  readonly maxPixels?: number;
};

function huffSel(nComponents: number, index: number): number {
  return nComponents > 1 && index > 0 ? 1 : 0;
}

function toScanComps(decoded: JpegCoefficients): ComponentCoeffs[] {
  const n = decoded.components.length;
  const out: ComponentCoeffs[] = [];
  for (let i = 0; i < n; i++) {
    const c = decoded.components[i];
    if (c === undefined) {
      throw jpegError("missing a scan");
    }
    const sel = huffSel(n, i);
    out.push({
      coeffs: c.coeffs,
      blockCols: c.blocksW,
      scanCols: c.scanBlocksW,
      scanRows: c.scanBlocksH,
      h: c.h,
      v: c.v,
      id: c.id,
      dcTbl: sel,
      acTbl: sel,
    });
  }
  return out;
}

function sofComps(components: readonly JpegCoeffComponent[]): SofComponent[] {
  return components.map((c) => ({
    id: c.id,
    h: c.h,
    v: c.v,
    qTable: c.qTable,
  }));
}

function writeQuantTables(
  out: ByteWriter,
  components: readonly JpegCoeffComponent[],
  quantTables: ReadonlyArray<JpegQuantTable | undefined>,
): void {
  const wrote = [false, false, false, false];
  for (const c of components) {
    const id = c.qTable;
    if (wrote[id] === true) {
      continue;
    }
    wrote[id] = true;
    const table = quantTables[id];
    if (table === undefined) {
      throw jpegError("missing a quantization table");
    }
    writeDqt(out, id, table.values, table.precision);
  }
}

/**
 * JFIF APP0 only when the color space is YCbCr (or gray). Adobe transform 0 is
 * RGB/CMYK: jpegtran omits APP0 and keeps APP14. No-JFIF / no-Adobe 3-component
 * is libjpeg YCbCr, so we emit JFIF.
 */
function emitJfif(decoded: JpegCoefficients): boolean {
  const n = decoded.components.length;
  if (n !== 1 && n !== 3) {
    return false;
  }
  if (decoded.adobe === 0) {
    return false;
  }
  return true;
}

function writeAdobe(out: ByteWriter, decoded: JpegCoefficients): void {
  const raw = decoded.adobeBytes;
  if (raw !== undefined) {
    writeApp14Payload(out, raw);
    return;
  }
  if (decoded.adobe !== undefined) {
    writeApp14(out, decoded.adobe);
  }
}

function validateTranscodeOptions(options: JpegTranscodeOptions | undefined): void {
  // Untyped JS callers can pass anything: check the runtime value, not the type.
  const progressive: unknown = options?.progressive;
  if (progressive !== undefined && typeof progressive !== "boolean") {
    throw jpegRangeError("progressive must be a boolean");
  }
}

/**
 * Re-entropy-codes a JPEG without touching its quantized coefficients:
 * pixel-identical output, optimized Huffman tables, optional progressive.
 * Restart intervals are dropped.
 *
 * APP/COM segments are stripped by default. Pass `metadata` to write EXIF / XMP / ICC
 * after APP0 (then Adobe APP14, then DQT…). If `metadata.exif` is omitted and the
 * source orientation is not 1, a one-tag EXIF APP1 is still emitted.
 */
export function transcodeJpeg(bytes: Uint8Array, options?: JpegTranscodeOptions): Uint8Array {
  validateTranscodeOptions(options);
  const decoded = decodeJpegCoefficients(bytes, options?.maxPixels);
  const n = decoded.components.length;
  if (n !== 1 && n !== 3 && n !== 4) {
    throw jpegError(`unsupported component count ${n}`);
  }
  const progressive = options?.progressive === true;
  const comps = toScanComps(decoded);

  const out = new ByteWriter();
  writeMarker(out, 0xd8);
  if (emitJfif(decoded)) {
    writeApp0(out);
  }
  const meta = options?.metadata;
  if (meta?.exif === undefined && decoded.orientation !== 1) {
    writeApp1(out, buildExifOrientationPayload(decoded.orientation));
  }
  writeJpegMetadata(out, meta);
  writeAdobe(out, decoded);
  writeQuantTables(out, decoded.components, decoded.quantTables);
  writeSof(out, progressive, decoded.width, decoded.height, sofComps(decoded.components));
  if (progressive) {
    encodeProgressiveScans(out, comps, decoded.mcuCols, decoded.mcuRows, progressiveScansFor(n));
  } else {
    encodeSequentialScans(out, comps, decoded.mcuCols, decoded.mcuRows);
  }
  writeMarker(out, 0xd9);
  return out.finish();
}
