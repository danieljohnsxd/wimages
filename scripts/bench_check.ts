/**
 * Perf regression guards for the product verbs, kept out of `pnpm test` (no
 * timing assertions there). Thresholds are generous — several times the
 * current numbers and far below the regressions they guard against — so a busy
 * machine does not flake them; a real regression blows straight through.
 *
 * ```
 *   pnpm bench:check
 * ```
 *
 * Inputs are deterministic noise: the worst case for the size ladders, since
 * nothing compresses and every rung is visited.
 */
import { encodeGif, encodePng, shrinkImage } from "../dist/index.js";

type Check = { readonly name: string; readonly limitMs: number; readonly run: () => unknown };

function noise(w: number, h: number, alpha: boolean, salt: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  let seed = 0x9e3779b9 ^ salt;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed >>> 24;
  }
  if (!alpha) {
    for (let i = 3; i < data.length; i += 4) {
      data[i] = 255;
    }
  }
  return data;
}

const rgba = { width: 1024, height: 1024, data: noise(1024, 1024, true, 1) };
const rgbaPng = encodePng(rgba);
const frames = Array.from({ length: 8 }, (_, i) => ({
  width: 400,
  height: 400,
  data: noise(400, 400, false, i + 2),
  delay: 50,
}));
const gif = encodeGif(frames, { loop: 0 });

const checks: Check[] = [
  {
    // Before the fast-probe PNG ladder + quantizer fixes, 2048² of the same took 104 s.
    name: "shrinkImage 1024² RGBA noise PNG → 256 KiB PNG",
    limitMs: 10_000,
    run: () => shrinkImage(rgbaPng, { maxBytes: 256 * 1024 }),
  },
  {
    // GIF ladder: colors, then frames, then size; each rung is a full dithered encode.
    name: "shrinkImage 8×400² noise GIF → 512 KiB GIF",
    limitMs: 15_000,
    run: () => shrinkImage(gif, { maxBytes: 512 * 1024 }),
  },
];

let failed = 0;
for (const check of checks) {
  const t0 = performance.now();
  check.run();
  const ms = performance.now() - t0;
  const ok = ms <= check.limitMs;
  if (!ok) {
    failed += 1;
  }
  console.log(
    `${ok ? "ok  " : "FAIL"} ${check.name}: ${ms.toFixed(0)} ms (limit ${check.limitMs} ms)`,
  );
}
if (failed > 0) {
  process.exitCode = 1;
}
