import { pngRangeError } from "./error.ts";

export type PngColorKind = "gray" | "gray-alpha" | "rgb" | "rgba" | "palette";

export type ColorAnalysis = {
  readonly kind: PngColorKind;
  readonly bitDepth: 1 | 2 | 4 | 8;
  /** Unique RGBA colors as 0xRRGGBBAA, insertion order. Only filled when palette is viable. */
  readonly palette: readonly number[];
  readonly hasAlpha: boolean;
};

export function rgbaKey(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function grayBitDepth(can1: boolean, can2: boolean, can4: boolean): 1 | 2 | 4 | 8 {
  if (can1) {
    return 1;
  }
  if (can2) {
    return 2;
  }
  if (can4) {
    return 4;
  }
  return 8;
}

export function paletteBitDepth(count: number): 1 | 2 | 4 | 8 {
  if (count <= 2) {
    return 1;
  }
  if (count <= 4) {
    return 2;
  }
  if (count <= 16) {
    return 4;
  }
  return 8;
}

function naturalKind(allGray: boolean, hasAlpha: boolean): Exclude<PngColorKind, "palette"> {
  if (allGray) {
    return hasAlpha ? "gray-alpha" : "gray";
  }
  return hasAlpha ? "rgba" : "rgb";
}

/** Packed scanline payload (no filter byte) plus optional extra chunk bytes (e.g. PLTE). */
function packedPayloadBytes(
  width: number,
  height: number,
  bitsPerPixel: number,
  extraBytes = 0,
): number {
  return height * Math.ceil((width * bitsPerPixel) / 8) + extraBytes;
}

export function analyzeRgba(
  data: Uint8Array,
  width: number,
  height: number,
  force?: PngColorKind | "auto",
): ColorAnalysis {
  if (data.length !== width * height * 4) {
    throw pngRangeError("RGBA data length must equal width * height * 4");
  }

  const palette: number[] = [];
  const seen = new Map<number, number>();
  let paletteViable = true;
  let allGray = true;
  let hasAlpha = false;
  let canGray1 = true;
  let canGray2 = true;
  let canGray4 = true;

  const pixelCount = width * height;
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 0;

    if (r !== g || g !== b) {
      allGray = false;
    }
    if (a !== 255) {
      hasAlpha = true;
    }
    if (r !== 0 && r !== 255) {
      canGray1 = false;
    }
    if (r !== 0 && r !== 85 && r !== 170 && r !== 255) {
      canGray2 = false;
    }
    if (r % 17 !== 0) {
      canGray4 = false;
    }

    if (paletteViable) {
      const key = rgbaKey(r, g, b, a);
      if (!seen.has(key)) {
        if (seen.size === 256) {
          paletteViable = false;
          palette.length = 0;
          seen.clear();
        } else {
          seen.set(key, palette.length);
          palette.push(key);
        }
      }
    }
  }

  const natural = naturalKind(allGray, hasAlpha);
  const mode = force ?? "auto";
  const grayDepth = grayBitDepth(canGray1, canGray2, canGray4);

  if (mode === "gray") {
    if (!allGray || hasAlpha) {
      throw pngRangeError("image is not opaque grayscale");
    }
    return {
      kind: "gray",
      bitDepth: grayDepth,
      palette: paletteViable ? palette : [],
      hasAlpha: false,
    };
  }

  if (mode === "gray-alpha") {
    if (!allGray) {
      throw pngRangeError("image is not grayscale");
    }
    return {
      kind: "gray-alpha",
      bitDepth: 8,
      palette: paletteViable ? palette : [],
      hasAlpha,
    };
  }

  if (mode === "rgb") {
    if (hasAlpha) {
      throw pngRangeError("image has alpha; cannot encode as rgb");
    }
    return {
      kind: "rgb",
      bitDepth: 8,
      palette: paletteViable ? palette : [],
      hasAlpha: false,
    };
  }

  if (mode === "rgba") {
    return {
      kind: "rgba",
      bitDepth: 8,
      palette: paletteViable ? palette : [],
      hasAlpha,
    };
  }

  if (mode === "palette") {
    if (!paletteViable) {
      throw pngRangeError("too many unique colors for a palette (max 256)");
    }
    return {
      kind: "palette",
      bitDepth: paletteBitDepth(palette.length),
      palette,
      hasAlpha,
    };
  }

  if (paletteViable) {
    const palDepth = paletteBitDepth(palette.length);
    if (natural === "gray") {
      // Gray 1/2/4/8 is always exact and needs no PLTE. Use palette only when
      // the indexed payload plus PLTE is strictly smaller (e.g. 16 irregular
      // grays at 4-bit vs 8-bit gray).
      const grayBytes = packedPayloadBytes(width, height, grayDepth);
      const palBytes = packedPayloadBytes(width, height, palDepth, palette.length * 3);
      if (palBytes < grayBytes) {
        return { kind: "palette", bitDepth: palDepth, palette, hasAlpha };
      }
      return { kind: "gray", bitDepth: grayDepth, palette, hasAlpha: false };
    }
    if (palette.length <= 16 || natural === "rgb" || natural === "rgba") {
      return { kind: "palette", bitDepth: palDepth, palette, hasAlpha };
    }
  }

  return {
    kind: natural,
    bitDepth: natural === "gray" ? grayDepth : 8,
    palette: paletteViable ? palette : [],
    hasAlpha,
  };
}
