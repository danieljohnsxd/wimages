const BASE = 65521;
const NMAX = 5552;

/** Adler-32 of `data` (zlib trailer). */
export function adler32(data: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  const n = data.length;
  let i = 0;
  while (i < n) {
    const end = i + NMAX < n ? i + NMAX : n;
    for (; i < end; i++) {
      s1 += data[i] ?? 0;
      s2 += s1;
    }
    s1 %= BASE;
    s2 %= BASE;
  }
  return ((s2 << 16) | s1) >>> 0;
}
