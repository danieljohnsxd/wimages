# AGENTS

## Goal

Pure TypeScript/JavaScript codecs for **PNG, JPEG, and GIF** (WebP is a goal, not shipped — do not advertise it in `package.json` until it exists). No Rust, no WASM, no canvas, no `ImageDecoder`, no `node:*` in library code. Same ESM build on **Node 24**, **Deno**, **Bun**, **Cloudflare Workers**, and modern evergreen browsers.

Pixels in, bytes out. Typed arrays + `Error` only.

## API shape: presets at natural boundaries

Numeric knobs (`level` 0–9, zstd’s −8…22) are the _implementation’s_ scale. A pure-JS codec exposes only a couple of boundaries the runtime actually has, so the public API names those and nothing else:

- PNG: `effort: "fast" | "strong"`. JPEG: `quality: "small" | "balanced" | "high"`. GIF: `dither: "none" | "floyd-steinberg"`.
- A number survives only where it is an interop convention users already speak (JPEG `quality: 80`). Never add a numeric tuning knob because the implementation happens to have one.
- The consumer-facing entry point is the product operation, not the codec: `shrinkImage(bytes, { maxSide, maxBytes })`. Codec functions stay exported for people who need them.
- Defaults are what an upload path wants: upright pixels, alpha composited on white, JPEG for photos, PNG for graphics/alpha, no private metadata (EXIF/XMP stripped; the ICC profile is kept because it defines the colors).

The reference use case is a web-app upload path: 2048 px long side, 1 MiB target, JPEG/PNG only, running in a Web Worker or a serverless action (e.g. Convex).

## Language target: ES2022

Keep `tsconfig` / tsdown at **ES2022**. ES2023–2025 do not change bit IO, Huffman, DCT, PNG filters, deflate, or VP8/VP8L.

| Edition | Verdict                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| ES2023  | Safe everywhere we care about. Copy-array methods (`toSorted`, …) allocate — do not use on codec loops.                  |
| ES2024  | Resizable `ArrayBuffer` + `transfer` exist; a doubling `Uint8Array` is enough.                                           |
| ES2025  | `Float16Array` is shipped (Node 24, Safari 18.2+, CF Workers) and is the **wrong** numeric type for PNG/JPEG/WebP. Skip. |

Do not raise `target` for APIs we are not committed to calling.

## TypeScript

- **TypeScript 7**: `typescript@^7`. Typecheck + type-aware lint run together in **oxlint** (`options.typeAware` + `options.typeCheck`).
- **Strict, erasable-syntax only.** Single root `tsconfig.json` (`strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noEmit`). Emit is **tsdown** only.
- Prefer real types over escapes (`any`, non-null `!`).
- Never use TSX (the `tsx` runner). Run TypeScript **directly through Node** — `node file.ts`, `node --test 'tests/**/*.ts'`. Type stripping is on by default since Node 22.18; do not add `--experimental-strip-types`. Local scripts need **Node ≥ 24**.
- Erasable syntax is the contract in three places and they must agree: `tsconfig` `erasableSyntaxOnly`, oxlint `typeCheck`, and Node strip-types. No enums, `namespace`, parameter properties, or `import =`. Never use `--experimental-transform-types`.

## Runtime / package

- **ES2022 ESM**, `"type": "module"`, `exports` with `import` + `types` only. No CJS, UMD, or dual packages.
- Library code: no `process`, `Buffer`, `document`, `window`, `fetch`, filesystem. Enforced by `no-restricted-globals` on `src/**`.
- `engines.node` is `>=22` for consumers of the emitted ESM; the dev toolchain (tests run `.ts` directly via type stripping) needs Node 24.
- Workers tracks Chrome V8, so language builtins are not the constraint. Avoid `SharedArrayBuffer` / `Atomics` (no threads on CF). Do not time inner loops with `Date.now()` / `performance.now()` on Workers — the clock freezes during CPU work.

## Layout

- `src/` — codecs + shared pixel types. Barrel: `src/index.ts`.
- `dist/` — tsdown emit (gitignored).
- `tests/` — `node:test` + `node:assert/strict`, import from `../dist/`.
- `ledger-<format>.md` — codec decisions (why, not how). Update when behavior or scope changes.
- `README.md` — consumer-facing scope, limits, and throughput numbers. Re-measure (`node scripts/bench.ts`) when a codec hot path changes.
- `vendor/` — local-only study copies (jsquash, heic-to, gifsicle-wasm-browser, cross-image, browser-image-compression), git-ignored. Not linted, formatted, or typechecked.

## Lint / format / build

- **oxlint** + **oxfmt** (not Biome). `.oxlintrc.json` / `.oxfmtrc.json` — `--init` defaults plus type-aware lint, `node:test` floating-promise allowlist, `no-restricted-globals` on `src/**`. Do not pile on house style.
- oxfmt: spaces, `printWidth` 100, double quotes.
- **tsdown**: ESM, `target: es2022`, `platform: "neutral"`, minify + `.d.ts`, no sourcemaps (not shipped in the package). Typecheck is oxlint, not a separate `tsc` emit.

```bash
pnpm check         # fmt:check + oxlint
pnpm fmt
pnpm lint          # type-aware rules + TS diagnostics
pnpm build         # tsdown → dist/
pnpm test          # build + node --test
```
