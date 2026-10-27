export type LitToken = { readonly kind: "lit"; readonly value: number };
export type MatchToken = {
  readonly kind: "match";
  readonly length: number;
  readonly distance: number;
};
export type Token = LitToken | MatchToken;

const WSIZE = 32768;
const WMASK = WSIZE - 1;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

export type Lz77Config = {
  readonly maxChain: number;
  readonly niceLength: number;
  readonly lazy: number;
  readonly insertAll: boolean;
};

export function lz77Config(level: number): Lz77Config {
  switch (level) {
    case 1:
      return { maxChain: 4, niceLength: 8, lazy: 0, insertAll: false };
    case 2:
      return { maxChain: 8, niceLength: 16, lazy: 0, insertAll: false };
    case 3:
      return { maxChain: 16, niceLength: 32, lazy: 0, insertAll: false };
    case 4:
      return { maxChain: 32, niceLength: 16, lazy: 4, insertAll: false };
    case 5:
      return { maxChain: 64, niceLength: 32, lazy: 16, insertAll: true };
    case 6:
      return { maxChain: 128, niceLength: 128, lazy: 16, insertAll: true };
    case 7:
      return { maxChain: 256, niceLength: 258, lazy: 32, insertAll: true };
    case 8:
      return { maxChain: 1024, niceLength: 258, lazy: 64, insertAll: true };
    default:
      return { maxChain: 4096, niceLength: 258, lazy: 258, insertAll: true };
  }
}

function hash3(data: Uint8Array, i: number): number {
  const a = data[i] ?? 0;
  const b = data[i + 1] ?? 0;
  const c = data[i + 2] ?? 0;
  return ((a << 10) ^ (b << 5) ^ c) & HASH_MASK;
}

function matchLen(data: Uint8Array, i: number, j: number, max: number): number {
  const n = data.length;
  let len = 0;
  while (len < max && i + len < n && j + len < n && (data[i + len] ?? 0) === (data[j + len] ?? 0)) {
    len += 1;
  }
  return len;
}

export function lz77(data: Uint8Array, config: Lz77Config): Token[] {
  const n = data.length;
  const tokens: Token[] = [];
  if (n === 0) {
    return tokens;
  }

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WSIZE).fill(-1);

  const insert = (pos: number): void => {
    if (pos + 2 >= n) {
      return;
    }
    const h = hash3(data, pos);
    prev[pos & WMASK] = head[h] ?? -1;
    head[h] = pos;
  };

  const findMatch = (pos: number): MatchToken | undefined => {
    if (pos + MIN_MATCH > n) {
      return undefined;
    }
    const h = hash3(data, pos);
    let p = head[h] ?? -1;
    let bestLen = MIN_MATCH - 1;
    let bestPos = -1;
    let chain = config.maxChain;
    while (p >= 0 && chain > 0) {
      chain -= 1;
      const dist = pos - p;
      if (dist > 0 && dist <= WSIZE) {
        const max = n - pos < MAX_MATCH ? n - pos : MAX_MATCH;
        const len = matchLen(data, pos, p, max);
        if (len > bestLen) {
          bestLen = len;
          bestPos = p;
          if (len >= config.niceLength) {
            break;
          }
        }
      }
      const next = prev[p & WMASK] ?? -1;
      if (next >= p) {
        break;
      }
      p = next;
    }
    if (bestPos < 0 || bestLen < MIN_MATCH) {
      return undefined;
    }
    return { kind: "match", length: bestLen, distance: pos - bestPos };
  };

  let i = 0;
  while (i < n) {
    const match = findMatch(i);
    if (match !== undefined && config.lazy > 0 && i + 1 < n && match.length < config.lazy) {
      insert(i);
      const next = findMatch(i + 1);
      if (next !== undefined && next.length > match.length) {
        tokens.push({ kind: "lit", value: data[i] ?? 0 });
        i += 1;
        continue;
      }
      const end = i + match.length;
      if (config.insertAll) {
        for (let p = i + 1; p < end; p++) {
          insert(p);
        }
      } else {
        insert(i + 1);
      }
      tokens.push(match);
      i = end;
      continue;
    }

    if (match !== undefined) {
      const end = i + match.length;
      if (config.insertAll) {
        for (let p = i; p < end; p++) {
          insert(p);
        }
      } else {
        insert(i);
      }
      tokens.push(match);
      i = end;
      continue;
    }

    tokens.push({ kind: "lit", value: data[i] ?? 0 });
    insert(i);
    i += 1;
  }

  return tokens;
}
