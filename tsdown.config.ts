import { defineConfig } from "tsdown";

/**
 * Library build (Rolldown/tsdown — the lib piece of the Vite+ stack).
 * ESM-only ES2022 emit for multi-runtime consumers (Node, Workers, Deno, …).
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    png: "src/entry/png.ts",
    jpeg: "src/entry/jpeg.ts",
    gif: "src/entry/gif.ts",
    resize: "src/entry/resize.ts",
  },
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: false,
  minify: true,
  treeshake: true,
  unbundle: false,
});
