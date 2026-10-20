// Illustrations whose stored fingerprints are practically identical (the same picture re-uploaded or lightly edited, e.g. a
// reprint with a new illustration id). No amount of image quality tells those apart, so the scanner treats them as a group.
// Pure; used by the catalog builder and by the tests.
import { HASH_WORDS, popcount32 } from './phash.ts';

/** Pairs closer than this many bits (of 256) count as twins. Two clean photos of the same card differ by a few dozen bits at most. */
export const TWIN_BITS = 16;

/** All pairs (i < j) of rows within `maxBits`, with their distance. `words` is the flat fingerprint array (HASH_WORDS per row). */
export function findTwins(words: Uint32Array, n: number, maxBits = TWIN_BITS): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = i * HASH_WORDS;
    for (let j = i + 1; j < n; j++) {
      const b = j * HASH_WORDS;
      // the first half of the bits already rules out nearly every pair
      let d = popcount32((words[a] ^ words[b]) >>> 0) + popcount32((words[a + 1] ^ words[b + 1]) >>> 0) + popcount32((words[a + 2] ^ words[b + 2]) >>> 0) + popcount32((words[a + 3] ^ words[b + 3]) >>> 0);
      if (d > maxBits) continue;
      for (let k = 4; k < HASH_WORDS; k++) d += popcount32((words[a + k] ^ words[b + k]) >>> 0);
      if (d <= maxBits) out.push([i, j, d]);
    }
  }
  return out;
}
