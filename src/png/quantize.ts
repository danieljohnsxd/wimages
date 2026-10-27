import { paletteBitDepth, rgbaKey, type ColorAnalysis } from "./color.ts";
import { pngRangeError } from "./error.ts";

type RgbaBin = {
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
  /** Nearest palette entry, filled in by `remapToPalette`. */
  index: number;
};

type Channel = 0 | 1 | 2 | 3;

function channelValue(bin: RgbaBin, channel: Channel): number {
  if (channel === 0) {
    return bin.r;
  }
  if (channel === 1) {
    return bin.g;
  }
  if (channel === 2) {
    return bin.b;
  }
  return bin.a;
}

function boxSplitAxis(bins: readonly RgbaBin[]): {
  readonly channel: Channel;
  readonly range: number;
} {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  let minA = 255;
  let maxA = 0;
  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i];
    if (bin === undefined) {
      continue;
    }
    if (bin.r < minR) {
      minR = bin.r;
    }
    if (bin.r > maxR) {
      maxR = bin.r;
    }
    if (bin.g < minG) {
      minG = bin.g;
    }
    if (bin.g > maxG) {
      maxG = bin.g;
    }
    if (bin.b < minB) {
      minB = bin.b;
    }
    if (bin.b > maxB) {
      maxB = bin.b;
    }
    if (bin.a < minA) {
      minA = bin.a;
    }
    if (bin.a > maxA) {
      maxA = bin.a;
    }
  }

  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;
  const rangeA = maxA - minA;
  let channel: Channel = 0;
  let range = rangeR;
  if (rangeG > range) {
    channel = 1;
    range = rangeG;
  }
  if (rangeB > range) {
    channel = 2;
    range = rangeB;
  }
  if (rangeA > range) {
    channel = 3;
    range = rangeA;
  }
  return { channel, range };
}

function splitBox(
  bins: RgbaBin[],
  channel: Channel,
): { readonly left: RgbaBin[]; readonly right: RgbaBin[] } {
  // Stable counting sort on one 8-bit channel: the same order as a stable
  // comparison sort, in O(n) instead of O(n log n) with a closure per compare.
  const offsets = new Int32Array(257);
  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i];
    if (bin !== undefined) {
      const slot = channelValue(bin, channel) + 1;
      offsets[slot] = (offsets[slot] ?? 0) + 1;
    }
  }
  for (let v = 0; v < 256; v++) {
    offsets[v + 1] = (offsets[v + 1] ?? 0) + (offsets[v] ?? 0);
  }
  const sorted = bins.slice();
  for (let i = 0; i < sorted.length; i++) {
    const bin = sorted[i];
    if (bin !== undefined) {
      const v = channelValue(bin, channel);
      const at = offsets[v] ?? 0;
      bins[at] = bin;
      offsets[v] = at + 1;
    }
  }

  let total = 0;
  for (let i = 0; i < bins.length; i++) {
    total += bins[i]?.count ?? 0;
  }

  const half = total / 2;
  let acc = 0;
  let splitAfter = 0;
  for (let i = 0; i < bins.length; i++) {
    acc += bins[i]?.count ?? 0;
    splitAfter = i;
    if (acc >= half) {
      break;
    }
  }
  if (splitAfter >= bins.length - 1) {
    splitAfter = bins.length - 2;
  }

  return {
    left: bins.slice(0, splitAfter + 1),
    right: bins.slice(splitAfter + 1),
  };
}

function averageColor(bins: readonly RgbaBin[]): number {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i];
    if (bin === undefined) {
      continue;
    }
    r += bin.r * bin.count;
    g += bin.g * bin.count;
    b += bin.b * bin.count;
    a += bin.a * bin.count;
    n += bin.count;
  }
  if (n === 0) {
    return rgbaKey(0, 0, 0, 255);
  }
  return rgbaKey(Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n));
}

type Box = {
  readonly bins: RgbaBin[];
  readonly channel: Channel;
  readonly range: number;
};

function box(bins: RgbaBin[]): Box {
  const { channel, range } = boxSplitAxis(bins);
  return { bins, channel, range };
}

/**
 * Split the box with the widest channel range (ties: lower channel, then
 * earlier box) until `maxColors` boxes. Each box's axis is computed once when
 * it is created, so a pass is O(boxes), not O(bins): on photographic input
 * (~10^6 unique colors) recomputing it per pass dominated the run time.
 */
function medianCut(bins: RgbaBin[], maxColors: number): RgbaBin[][] {
  const leaves: Box[] = [box(bins)];
  while (leaves.length < maxColors) {
    let bestIndex = -1;
    let bestRange = -1;
    let bestChannel: Channel = 3;
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      if (leaf === undefined || leaf.bins.length < 2) {
        continue;
      }
      if (leaf.range > bestRange || (leaf.range === bestRange && leaf.channel < bestChannel)) {
        bestRange = leaf.range;
        bestChannel = leaf.channel;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) {
      break;
    }
    const chosen = leaves[bestIndex];
    if (chosen === undefined) {
      break;
    }
    const { left, right } = splitBox(chosen.bins, chosen.channel);
    if (left.length === 0 || right.length === 0) {
      break;
    }
    leaves[bestIndex] = box(left);
    leaves.push(box(right));
  }
  return leaves.map((leaf) => leaf.bins);
}

/**
 * Exact nearest palette entry (squared RGBA distance, ties → lowest index).
 * Entries are visited in red order outward from `r` and the walk stops once
 * the red gap alone exceeds the best distance, so a 256-entry search touches a
 * few dozen entries instead of all of them.
 */
export type PaletteIndex = {
  /** Palette indexes sorted by red, then index. */
  readonly order: Int32Array;
  readonly r: Int32Array;
  readonly g: Int32Array;
  readonly b: Int32Array;
  readonly a: Int32Array;
};

export function indexPalette(
  palette: readonly number[],
  options?: { readonly ignoreAlpha?: boolean; readonly skip?: number },
): PaletteIndex {
  const skip = options?.skip;
  const ignoreAlpha = options?.ignoreAlpha === true;
  let n = 0;
  for (let i = 0; i < palette.length; i++) {
    if (i !== skip) {
      n += 1;
    }
  }
  const order = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < palette.length; i++) {
    if (i === skip) {
      continue;
    }
    order[k] = i;
    k += 1;
  }
  // Channel arrays are indexed by palette index (sized to the full palette).
  const r = new Int32Array(palette.length);
  const g = new Int32Array(palette.length);
  const b = new Int32Array(palette.length);
  const a = new Int32Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    const color = palette[i] ?? 0;
    r[i] = (color >>> 24) & 0xff;
    g[i] = (color >>> 16) & 0xff;
    b[i] = (color >>> 8) & 0xff;
    a[i] = ignoreAlpha ? 0 : color & 0xff;
  }
  order.sort((x, y) => (r[x] ?? 0) - (r[y] ?? 0) || x - y);
  return { order, r, g, b, a };
}

export function nearestPaletteIndex(
  r: number,
  g: number,
  b: number,
  a: number,
  index: PaletteIndex,
): number {
  const { order } = index;
  const n = order.length;
  // First entry with red ≥ r.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((index.r[order[mid] ?? 0] ?? 0) < r) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  let best = order[0] ?? 0;
  let bestDist = Infinity;
  const consider = (k: number): boolean => {
    const i = order[k] ?? 0;
    const dr = r - (index.r[i] ?? 0);
    if (dr * dr > bestDist) {
      return false;
    }
    const dg = g - (index.g[i] ?? 0);
    const db = b - (index.b[i] ?? 0);
    const da = a - (index.a[i] ?? 0);
    const dist = dr * dr + dg * dg + db * db + da * da;
    if (dist < bestDist || (dist === bestDist && i < best)) {
      bestDist = dist;
      best = i;
    }
    return true;
  };
  let up = lo;
  let down = lo - 1;
  while (up < n || down >= 0) {
    if (up < n && !consider(up)) {
      up = n;
    } else {
      up += 1;
    }
    if (down >= 0 && !consider(down)) {
      down = -1;
    } else {
      down -= 1;
    }
  }
  return best;
}

function analysisFromPalette(palette: readonly number[]): ColorAnalysis {
  let hasAlpha = false;
  for (let i = 0; i < palette.length; i++) {
    if (((palette[i] ?? 0) & 0xff) !== 255) {
      hasAlpha = true;
      break;
    }
  }
  return {
    kind: "palette",
    bitDepth: paletteBitDepth(palette.length),
    palette,
    hasAlpha,
  };
}

function collectBins(data: Uint8Array, pixelCount: number): Map<number, RgbaBin> {
  const bins = new Map<number, RgbaBin>();
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3] ?? 0;
    const key = rgbaKey(r, g, b, a);
    const existing = bins.get(key);
    if (existing !== undefined) {
      existing.count += 1;
    } else {
      bins.set(key, { r, g, b, a, count: 1, index: 0 });
    }
  }
  return bins;
}

/**
 * Every pixel → its bin's nearest palette color. The nearest entry is computed
 * once per unique color (stored on the bin), so the per-pixel work is one map
 * lookup into the table `collectBins` already built.
 */
function remapToPalette(
  data: Uint8Array,
  pixelCount: number,
  palette: readonly number[],
  bins: ReadonlyMap<number, RgbaBin>,
): Uint8Array {
  const lookup = indexPalette(palette);
  for (const bin of bins.values()) {
    bin.index = nearestPaletteIndex(bin.r, bin.g, bin.b, bin.a, lookup);
  }
  const out = new Uint8Array(data.length);
  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    const key = rgbaKey(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0);
    const color = palette[bins.get(key)?.index ?? 0] ?? 0;
    out[i] = (color >>> 24) & 0xff;
    out[i + 1] = (color >>> 16) & 0xff;
    out[i + 2] = (color >>> 8) & 0xff;
    out[i + 3] = color & 0xff;
  }
  return out;
}

export function quantizeToPalette(
  data: Uint8Array,
  width: number,
  height: number,
  maxColors: number,
): { readonly data: Uint8Array; readonly analysis: ColorAnalysis } {
  if (data.length !== width * height * 4) {
    throw pngRangeError("RGBA data length must equal width * height * 4");
  }
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) {
    throw pngRangeError("maxColors must be an integer from 2 to 256");
  }

  const pixelCount = width * height;
  const bins = collectBins(data, pixelCount);

  if (bins.size <= maxColors) {
    return {
      data,
      analysis: analysisFromPalette([...bins.keys()]),
    };
  }

  const leaves = medianCut([...bins.values()], maxColors);
  const palette: number[] = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    if (leaf === undefined || leaf.length === 0) {
      continue;
    }
    const key = averageColor(leaf);
    if (!seen.has(key)) {
      seen.set(key, palette.length);
      palette.push(key);
    }
  }

  return {
    data: remapToPalette(data, pixelCount, palette, bins),
    analysis: analysisFromPalette(palette),
  };
}
