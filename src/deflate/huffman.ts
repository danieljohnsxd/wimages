import { reverseBits } from "./bits.ts";

export type HuffmanTable = {
  readonly lengths: Uint8Array;
  readonly codes: Uint16Array;
};

export function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const blCount = new Uint32Array(16);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] ?? 0;
    if (len > 15) {
      throw new RangeError("Huffman code length exceeds 15");
    }
    if (len > 0) {
      blCount[len] = (blCount[len] ?? 0) + 1;
    }
  }
  const nextCode = new Uint32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + (blCount[bits - 1] ?? 0)) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let n = 0; n < lengths.length; n++) {
    const len = lengths[n] ?? 0;
    if (len !== 0) {
      const c = nextCode[len] ?? 0;
      codes[n] = reverseBits(c, len);
      nextCode[len] = c + 1;
    }
  }
  return codes;
}

export function makeTable(lengths: Uint8Array): HuffmanTable {
  return { lengths, codes: canonicalCodes(lengths) };
}

function heapLess(freq: Uint32Array, a: number, b: number): boolean {
  const fa = freq[a] ?? 0;
  const fb = freq[b] ?? 0;
  return fa < fb || (fa === fb && a < b);
}

function heapSiftUp(heap: number[], freq: Uint32Array, i: number): void {
  const node = heap[i] ?? 0;
  let idx = i;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    const pNode = heap[parent] ?? 0;
    if (!heapLess(freq, node, pNode)) {
      break;
    }
    heap[idx] = pNode;
    idx = parent;
  }
  heap[idx] = node;
}

function heapSiftDown(heap: number[], freq: Uint32Array, i: number): void {
  const n = heap.length;
  const node = heap[i] ?? 0;
  let idx = i;
  for (;;) {
    const left = idx * 2 + 1;
    if (left >= n) {
      break;
    }
    let best = left;
    const right = left + 1;
    if (right < n) {
      const rNode = heap[right] ?? 0;
      const lNode = heap[left] ?? 0;
      if (heapLess(freq, rNode, lNode)) {
        best = right;
      }
    }
    const bNode = heap[best] ?? 0;
    if (!heapLess(freq, bNode, node)) {
      break;
    }
    heap[idx] = bNode;
    idx = best;
  }
  heap[idx] = node;
}

function heapPush(heap: number[], freq: Uint32Array, node: number): void {
  heap.push(node);
  heapSiftUp(heap, freq, heap.length - 1);
}

function heapPop(heap: number[], freq: Uint32Array): number {
  const first = heap[0] ?? 0;
  const last = heap.pop();
  if (last === undefined || heap.length === 0) {
    return first;
  }
  heap[0] = last;
  heapSiftDown(heap, freq, 0);
  return first;
}

/**
 * zlib `gen_bitlen` overflow repair on leaf counts: each step reduces the
 * Kraft sum by exactly 2^{-maxBits}, so a 2+-symbol code lands on Kraft = 1.
 */
function repairToComplete(lengths: Uint8Array, freq: ArrayLike<number>, maxBits: number): void {
  const blCount = new Int32Array(16);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] ?? 0;
    if (len > 0) {
      blCount[len] = (blCount[len] ?? 0) + 1;
    }
  }

  let total = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    total += (blCount[bits] ?? 0) << (maxBits - bits);
  }
  const goal = 1 << maxBits;
  while (total > goal) {
    let bits = maxBits - 1;
    while (bits > 0 && (blCount[bits] ?? 0) === 0) {
      bits -= 1;
    }
    if (bits === 0) {
      break;
    }
    blCount[bits] = (blCount[bits] ?? 0) - 1;
    blCount[bits + 1] = (blCount[bits + 1] ?? 0) + 2;
    blCount[maxBits] = (blCount[maxBits] ?? 0) - 1;
    total -= 1;
  }

  const order: number[] = [];
  for (let i = 0; i < lengths.length; i++) {
    if ((lengths[i] ?? 0) > 0) {
      order.push(i);
    }
  }
  order.sort((a, b) => {
    const fa = freq[a] ?? 0;
    const fb = freq[b] ?? 0;
    if (fa !== fb) {
      return fb - fa;
    }
    return a - b;
  });

  let k = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    let remain = blCount[bits] ?? 0;
    while (remain > 0) {
      const sym = order[k];
      if (sym === undefined) {
        return;
      }
      lengths[sym] = bits;
      k += 1;
      remain -= 1;
    }
  }
}

/**
 * Length-limited Huffman code lengths from symbol frequencies.
 *
 * Two or more used symbols always yield a complete prefix code (Kraft sum 1)
 * with every length in 1..maxBits. A single used symbol is the RFC 1951
 * incomplete case: one code of length 1. Pass `minUsed` 2 for the 19-symbol
 * code-length alphabet, which zlib's inflater requires to be complete.
 */
export function codeLengthsFromFreq(
  freq: ArrayLike<number>,
  maxBits: number,
  minUsed = 1,
): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const weight = new Uint32Array(n);
  const used: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = freq[i] ?? 0;
    if (f > 0) {
      weight[i] = f;
      used.push(i);
    }
  }
  if (used.length === 0 && minUsed < 2) {
    return lengths;
  }
  if (used.length < minUsed) {
    for (let i = 0; i < n && used.length < minUsed; i++) {
      if (weight[i] === 0) {
        weight[i] = 1;
        used.push(i);
      }
    }
  }
  if (used.length === 0) {
    return lengths;
  }
  if (used.length === 1) {
    lengths[used[0] ?? 0] = 1;
    return lengths;
  }

  const nUsed = used.length;
  const nodeFreq = new Uint32Array(nUsed * 2);
  const parent = new Int32Array(nUsed * 2);
  parent.fill(-1);
  for (let i = 0; i < nUsed; i++) {
    nodeFreq[i] = weight[used[i] ?? 0] ?? 0;
  }

  const heap: number[] = [];
  for (let i = 0; i < nUsed; i++) {
    heapPush(heap, nodeFreq, i);
  }

  let next = nUsed;
  while (heap.length > 1) {
    const a = heapPop(heap, nodeFreq);
    const b = heapPop(heap, nodeFreq);
    nodeFreq[next] = (nodeFreq[a] ?? 0) + (nodeFreq[b] ?? 0);
    parent[a] = next;
    parent[b] = next;
    heapPush(heap, nodeFreq, next);
    next += 1;
  }

  const depth = new Uint16Array(next);
  for (let i = next - 2; i >= 0; i--) {
    const p = parent[i] ?? -1;
    depth[i] = p < 0 ? 0 : (depth[p] ?? 0) + 1;
  }

  let overflowed = false;
  for (let i = 0; i < nUsed; i++) {
    let d = depth[i] ?? 0;
    if (d === 0) {
      d = 1;
    }
    if (d > maxBits) {
      overflowed = true;
      d = maxBits;
    }
    lengths[used[i] ?? 0] = d;
  }
  if (overflowed) {
    repairToComplete(lengths, weight, maxBits);
  }
  return lengths;
}

export function rleCodeLengths(lengths: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < lengths.length) {
    const len = lengths[i] ?? 0;
    let run = 1;
    while (i + run < lengths.length && (lengths[i + run] ?? 0) === len) {
      run += 1;
    }
    if (len === 0) {
      let remain = run;
      while (remain >= 11) {
        const n = remain > 138 ? 138 : remain;
        out.push(18, n - 11);
        remain -= n;
      }
      if (remain >= 3) {
        out.push(17, remain - 3);
        remain = 0;
      }
      while (remain > 0) {
        out.push(0);
        remain -= 1;
      }
    } else {
      out.push(len);
      let remain = run - 1;
      while (remain >= 3) {
        const n = remain > 6 ? 6 : remain;
        out.push(16, n - 3);
        remain -= n;
      }
      while (remain > 0) {
        out.push(len);
        remain -= 1;
      }
    }
    i += run;
  }
  return out;
}
