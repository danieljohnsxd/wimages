/**
 * Throughput + peak-memory numbers for the README.
 *
 * ```
 *   pnpm build && node scripts/bench.ts            # 4000×3000 (12 MP)
 *   node scripts/bench.ts 1920 1080
 * ```
 *
 * Synthetic photo-like content (smooth gradients + noise) so the numbers are
 * reproducible. Reports wall time and the RSS delta around each call.
 */
import {
  resize,
  shrinkImage,
  decodeGif,
  decodeJpeg,
  decodePng,
  encodeGif,
  encodeJpeg,
  encodePng,
  optimizeImage,
} from "../dist/index.js";

const width = Number(process.argv[2] ?? 4000);
const height = Number(process.argv[3] ?? 3000);

function synth(w: number, h: number): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(w * h * 4);
  let seed = 0x9e3779b9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed >>> 24) & 15;
      const i = (y * w + x) * 4;
      data[i] = ((x * 255) / w + noise) & 255;
      data[i + 1] = ((y * 255) / h + noise) & 255;
      data[i + 2] = (((x + y) * 127) / (w + h) + 64 + noise) & 255;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function measure<T>(label: string, fn: () => T): T {
  if (globalThis.gc) globalThis.gc();
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  const rss1 = process.memoryUsage().rss;
  const size = out instanceof Uint8Array ? `${(out.length / 1024).toFixed(0)} KB` : "";
  console.log(
    `${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms  rss +${((rss1 - rss0) / 1048576).toFixed(0).padStart(4)} MB  ${size}`,
  );
  return out;
}

const img = synth(width, height);
console.log(
  `${width}×${height} (${((width * height) / 1e6).toFixed(1)} MP), node ${process.version}`,
);

const jpg = measure("encodeJpeg balanced", () => encodeJpeg(img, { quality: "balanced" }));
measure("decodeJpeg", () => decodeJpeg(jpg));
const jpgH = measure("encodeJpeg high", () => encodeJpeg(img, { quality: "high" }));
measure("decodeJpeg high", () => decodeJpeg(jpgH));
const jpgP = measure("encodeJpeg progressive", () =>
  encodeJpeg(img, { quality: "balanced", progressive: true }),
);
measure("decodeJpeg progressive", () => decodeJpeg(jpgP));
const pngFast = measure("encodePng fast", () => encodePng(img, { effort: "fast" }));
measure("decodePng", () => decodePng(pngFast));
measure("encodePng strong", () => encodePng(img, { effort: "strong" }));
if (width * height <= 4_000_000) {
  const gif = measure("encodeGif", () => encodeGif(img));
  measure("decodeGif", () => decodeGif(gif));
}

measure("resize → 2048 (lanczos3)", () => resize(img, { maxSide: 2048 }));
measure("shrinkImage 12MP jpeg", () => shrinkImage(jpg).bytes);
measure("optimizeImage 12MP jpeg", () => optimizeImage(jpg).bytes);
