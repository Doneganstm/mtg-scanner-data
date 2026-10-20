// Nearest-neighbour search over the art-hash index. Pure JS, shared with the Node tools (eval + builder).
import { HASH_WORDS } from './phash.ts';

export interface SearchResult {
  /** Row in the index of the closest illustration, or -1 for an empty index. */
  index: number;
  /** Hamming distance (0-256) of the closest illustration. */
  distance: number;
  /** Distance of the runner-up: the closest illustration that is not a twin of the winner (see ArtIndex.setTwins). */
  second: number;
  /** Rows of illustrations whose artwork is practically the same as the winner's; they cannot be told apart by looking, only by title / set. */
  twins?: number[];
  /** The closest few entries (best first) with their distances, for "did you mean ..." suggestions. */
  top?: { row: number; distance: number }[];
}

export function wordsFromBytes(bytes: Uint8Array): Uint32Array {
  const out = new Uint32Array(HASH_WORDS);
  for (let i = 0; i < HASH_WORDS; i++) {
    const o = i * 4;
    out[i] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  }
  return out;
}

export function bytesFromWords(words: Uint32Array): Uint8Array {
  const out = new Uint8Array(HASH_WORDS * 4);
  for (let i = 0; i < HASH_WORDS; i++) {
    out[i * 4] = words[i] & 255;
    out[i * 4 + 1] = (words[i] >>> 8) & 255;
    out[i * 4 + 2] = (words[i] >>> 16) & 255;
    out[i * 4 + 3] = (words[i] >>> 24) & 255;
  }
  return out;
}

/** Bits set in every 16-bit value: two lookups replace a dozen bit operations per word. */
const POP = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POP[i] = POP[i >> 1] + (i & 1);

/** Bits compared in the coarse pass: the first 128 of 256. */
const COARSE_BITS = 128;
/** How many entries the coarse pass hands to the exact pass. */
const SHORTLIST = 3000;
/** Entries handled per step; each step is a fraction of a millisecond even on a slow phone. */
const STEP = 600;

/** The few closest entries seen so far; the runner-up that matters is the closest one that is not a twin of the winner. */
export class Ranker {
  readonly d = [257, 257, 257, 257];
  readonly i = [-1, -1, -1, -1];

  push(dist: number, idx: number) {
    if (dist >= this.d[3]) return;
    let p = 3;
    while (p > 0 && this.d[p - 1] > dist) {
      this.d[p] = this.d[p - 1];
      this.i[p] = this.i[p - 1];
      p--;
    }
    this.d[p] = dist;
    this.i[p] = idx;
  }

  result(index: ArtIndex): SearchResult {
    const best = this.i[0];
    const twins = best >= 0 ? index.twinsOf(best) : [];
    let second = 257;
    for (let k = 1; k < 4; k++) {
      if (this.i[k] >= 0 && !twins.includes(this.i[k])) {
        second = this.d[k];
        break;
      }
    }
    const top: { row: number; distance: number }[] = [];
    for (let k = 0; k < 4; k++) if (this.i[k] >= 0) top.push({ row: this.i[k], distance: this.d[k] });
    return { index: best, distance: this.d[0], second, twins, top };
  }
}

export class ArtIndex {
  readonly size: number;
  readonly ids: string[];
  readonly words: Uint32Array;
  /** Coarse-pass distances; reused between searches. */
  private readonly coarse: Uint8Array;
  private rows: Map<string, number> | null = null;
  private twins: Map<number, number[]> = new Map();

  constructor(ids: string[], words: Uint32Array) {
    this.ids = ids;
    this.words = words;
    this.size = ids.length;
    this.coarse = new Uint8Array(ids.length);
  }

  /** Pairs of illustration ids whose stored fingerprints are nearly identical (art_twin table). */
  setTwins(pairs: [string, string][]) {
    this.twins = new Map();
    for (const [a, b] of pairs) {
      const ra = this.rowOf(a);
      const rb = this.rowOf(b);
      if (ra < 0 || rb < 0 || ra === rb) continue;
      if (!this.twins.has(ra)) this.twins.set(ra, []);
      if (!this.twins.has(rb)) this.twins.set(rb, []);
      this.twins.get(ra)!.push(rb);
      this.twins.get(rb)!.push(ra);
    }
  }

  twinsOf(row: number): number[] {
    return this.twins.get(row) ?? [];
  }

  /** Row of an illustration in the index, or -1. */
  rowOf(illustrationId: string): number {
    if (!this.rows) {
      this.rows = new Map();
      for (let i = 0; i < this.size; i++) this.rows.set(this.ids[i], i);
    }
    return this.rows.get(illustrationId) ?? -1;
  }

  /** Smallest Hamming distance between any of the query fingerprints and the stored one in `row` (257 for a bad row). */
  distanceTo(queries: Uint32Array[], row: number): number {
    if (row < 0 || row >= this.size) return 257;
    const st = new Ranker();
    this.exactPass(queries, [row], 0, 1, st);
    return st.d[0];
  }

  /**
   * Two stages. (1) A cheap pass compares half of every fingerprint against the centre alignment only and keeps
   * the SHORTLIST closest entries. (2) The exact pass compares full fingerprints, all alignments, on just those.
   * Roughly 9x less work than comparing everything, with near-identical answers (see tools/eval.ts).
   */
  search(queries: Uint32Array[]): SearchResult {
    const hist = new Int32Array(COARSE_BITS + 1);
    this.coarsePass(queries[0], 0, this.size, hist);
    const limit = this.limitFor(hist);
    const picked: number[] = [];
    this.pick(limit, 0, this.size, picked);
    const st = new Ranker();
    this.exactPass(queries, picked, 0, picked.length, st);
    return st.result(this);
  }

  /**
   * Same result as search(), but every step is tiny and the loop yields to the event loop between groups of steps,
   * so taps and animations stay responsive even though Hermes runs this far slower than a desktop JIT.
   */
  async searchAsync(queries: Uint32Array[], sliceMs = 4): Promise<SearchResult> {
    let sliceStart = Date.now();
    const breathe = async () => {
      if (Date.now() - sliceStart >= sliceMs) {
        await new Promise<void>((r) => setTimeout(r, 0));
        sliceStart = Date.now();
      }
    };
    const hist = new Int32Array(COARSE_BITS + 1);
    for (let i = 0; i < this.size; i += STEP) {
      this.coarsePass(queries[0], i, Math.min(this.size, i + STEP), hist);
      await breathe();
    }
    const limit = this.limitFor(hist);
    const picked: number[] = [];
    for (let i = 0; i < this.size; i += STEP * 4) {
      this.pick(limit, i, Math.min(this.size, i + STEP * 4), picked);
      await breathe();
    }
    const st = new Ranker();
    for (let c = 0; c < picked.length; c += STEP / 2) {
      this.exactPass(queries, picked, c, Math.min(picked.length, c + STEP / 2), st);
      await breathe();
    }
    return st.result(this);
  }

  /** Coarse distance (first 128 bits, centre alignment) for entries [from, to); also tallies a histogram. */
  private coarsePass(q: Uint32Array, from: number, to: number, hist: Int32Array) {
    const w = this.words;
    const out = this.coarse;
    const q0 = q[0];
    const q1 = q[1];
    const q2 = q[2];
    const q3 = q[3];
    for (let i = from; i < to; i++) {
      const b = i * HASH_WORDS;
      const x0 = (q0 ^ w[b]) >>> 0;
      const x1 = (q1 ^ w[b + 1]) >>> 0;
      const x2 = (q2 ^ w[b + 2]) >>> 0;
      const x3 = (q3 ^ w[b + 3]) >>> 0;
      const d = POP[x0 & 0xffff] + POP[x0 >>> 16] + POP[x1 & 0xffff] + POP[x1 >>> 16] + POP[x2 & 0xffff] + POP[x2 >>> 16] + POP[x3 & 0xffff] + POP[x3 >>> 16];
      out[i] = d;
      hist[d]++;
    }
  }

  /** Largest coarse distance that keeps at least SHORTLIST entries (counting sort over the 0-128 range). */
  private limitFor(hist: Int32Array): number {
    let limit = 0;
    let seen = 0;
    while (limit < hist.length - 1 && seen + hist[limit] < SHORTLIST) seen += hist[limit++];
    return limit;
  }

  private pick(limit: number, from: number, to: number, picked: number[]) {
    const d = this.coarse;
    for (let i = from; i < to; i++) if (d[i] <= limit) picked.push(i);
  }

  /** Exact distance over all 256 bits and every alignment variant, for shortlisted entries [from, to). */
  private exactPass(queries: Uint32Array[], candidates: number[], from: number, to: number, st: Ranker) {
    const w = this.words;
    for (let c = from; c < to; c++) {
      const i = candidates[c];
      const base = i * HASH_WORDS;
      let dMin = 257;
      for (let q = 0; q < queries.length; q++) {
        const qw = queries[q];
        let d = 0;
        for (let k = 0; k < HASH_WORDS; k++) {
          const x = (qw[k] ^ w[base + k]) >>> 0;
          d += POP[x & 0xffff] + POP[x >>> 16];
        }
        if (d < dMin) dMin = d;
      }
      st.push(dMin, i);
    }
  }
}
