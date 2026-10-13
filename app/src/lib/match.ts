// Nearest-neighbour search over the art-hash index. Pure JS, shared with the Node tools (eval + builder).
import { HASH_WORDS, popcount32 } from './phash.ts';

export interface SearchResult {
  /** Row in the index of the closest illustration, or -1 for an empty index. */
  index: number;
  /** Hamming distance (0-256) of the closest illustration. */
  distance: number;
  /** Distance of the runner-up (a different illustration). */
  second: number;
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

export class ArtIndex {
  readonly size: number;
  readonly ids: string[];
  readonly words: Uint32Array;
  constructor(ids: string[], words: Uint32Array) {
    this.ids = ids;
    this.words = words;
    this.size = ids.length;
  }

  /** Each query is one alignment variant of the same physical card; the best variant per entry wins. */
  search(queries: Uint32Array[]): SearchResult {
    let best = 257;
    let second = 257;
    let bestIdx = -1;
    const w = this.words;
    for (let i = 0; i < this.size; i++) {
      const base = i * HASH_WORDS;
      let dMin = 257;
      for (let q = 0; q < queries.length; q++) {
        const qw = queries[q];
        let d = 0;
        for (let k = 0; k < 4; k++) d += popcount32((qw[k] ^ w[base + k]) >>> 0);
        if (d >= second && d >= dMin) continue; // cannot improve anything
        for (let k = 4; k < HASH_WORDS; k++) d += popcount32((qw[k] ^ w[base + k]) >>> 0);
        if (d < dMin) dMin = d;
      }
      if (dMin < best) {
        second = best;
        best = dMin;
        bestIdx = i;
      } else if (dMin < second) {
        second = dMin;
      }
    }
    return { index: bestIdx, distance: best, second };
  }
}
