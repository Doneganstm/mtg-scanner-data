// Continuous low-frequency descriptors of the art, used to shortlist candidates when the card is off-centre or badly lit.
// The binary fingerprint (phash.ts) is robust to lighting but fragile to shifts of the card; a descriptor made of DCT coefficient VALUES
// changes smoothly with a shift, so it finds the card when the fingerprint's alignment search misses. It is fragile to glare unless the
// grid is flattened first. Two variants cover both: 'winsor' (clip extremes) is best for shifts, 'flat' (divide out the lighting, then clip)
// is best for glare and side light. See tools/desc-eval2.ts for the measurements.
// Pure; the 32x32 luma grid comes from phash.lumaGrid.

const GRID = 32;
const B = 8; // coefficients per axis kept in the descriptor (the 8x8 low-frequency block)

function sortedCopy(a: Float32Array): Float32Array {
  'worklet';
  return Float32Array.from(a).sort();
}

/** Clip the darkest 4% and brightest 10% of cells: removes blown-out glare and deep shadow from the picture. */
export function winsorize(g: Float32Array): Float32Array {
  'worklet';
  const s = sortedCopy(g);
  const lo = s[Math.floor(g.length * 0.04)];
  const hi = s[Math.floor(g.length * 0.9)];
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.min(hi, Math.max(lo, g[i]));
  return out;
}

/** Divide by a heavy local average (the lighting estimate), then clip. Cancels side light and soft glare. */
export function flatten(g: Float32Array): Float32Array {
  'worklet';
  const R = 6;
  const out = new Float32Array(g.length);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= GRID) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= GRID) continue;
          s += g[yy * GRID + xx];
          n++;
        }
      }
      out[y * GRID + x] = (g[y * GRID + x] / Math.max(12, s / n)) * 128;
    }
  }
  return winsorize(out);
}

export type DescriptorKind = 'winsor' | 'flat';

/** Number of values in a descriptor restricted to coefficients with u, v < dim (DC excluded). */
export const descriptorLength = (dim: number) => {
  'worklet';
  return dim * dim - 1;
};

/** Unit-length vector of the lowest dim x dim DCT coefficients (minus DC) of the preprocessed grid. */
export function describe(grid: Float32Array, kind: DescriptorKind, dim = B): Float32Array {
  'worklet';
  const COS = new Float32Array(dim * GRID);
  for (let u = 0; u < dim; u++) for (let x = 0; x < GRID; x++) COS[u * GRID + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * GRID));
  const g = kind === 'winsor' ? winsorize(grid) : flatten(grid);
  const rows = new Float32Array(GRID * dim);
  for (let y = 0; y < GRID; y++) {
    for (let u = 0; u < dim; u++) {
      let s = 0;
      for (let x = 0; x < GRID; x++) s += g[y * GRID + x] * COS[u * GRID + x];
      rows[y * dim + u] = s;
    }
  }
  const out = new Float32Array(descriptorLength(dim));
  let n = 0;
  let norm = 0;
  for (let v = 0; v < dim; v++) {
    for (let u = 0; u < dim; u++) {
      if (u === 0 && v === 0) continue;
      let s = 0;
      for (let y = 0; y < GRID; y++) s += rows[y * dim + u] * COS[v * GRID + y];
      out[n++] = s;
      norm += s * s;
    }
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Indexes of the `k` entries most similar (largest dot product) to the query, best first. refs holds N descriptors of length `len`. */
export function topSimilar(query: Float32Array, refs: Float32Array, len: number, k: number): number[] {
  const n = (refs.length / len) | 0;
  const best: { i: number; s: number }[] = [];
  let worst = -2;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * len;
    for (let j = 0; j < len; j++) s += query[j] * refs[o + j];
    if (best.length < k || s > worst) {
      best.push({ i, s });
      if (best.length > k) {
        best.sort((a, b) => b.s - a.s);
        best.length = k;
      }
      if (best.length === k) worst = Math.min(...best.map((x) => x.s));
    }
  }
  best.sort((a, b) => b.s - a.s);
  return best.map((x) => x.i);
}
