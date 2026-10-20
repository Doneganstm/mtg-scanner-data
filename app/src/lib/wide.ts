// Tier 1b of the art search: what to measure on a frame when the fast fingerprint search is not sure (card off-centre, bad light, glare).
//
//   25 alignments of the binary fingerprint        -> exact re-ranking of a shortlist (shift tolerance)
//   5 'flat' descriptors (centre + 4 far shifts)   -> shortlist by continuous low-frequency structure, with the lighting divided out
//                                                     (tolerates shift, side light and soft glare)
//   5 masked 16x16 luma tilings                    -> shortlist that ignores blown-out patches (hard glare); only built when something is blown out
//
// buildWideQuery runs on the camera thread (it only reads pixels and does arithmetic); the matching side lives in wideIndex.ts.
// Pure and shared with the Node tools, so the simulations measure exactly the code the phone runs.
import { describe, descriptorLength } from './descriptor.ts';
import { ART_BOX, HASH_WORDS, SHIFT_X, SHIFT_Y, phashFromGrid, shiftedGrids, type Rect, type Rotation } from './phash.ts';

export const DESC_LEN = descriptorLength(8); // 63
export const TILE_N = 16;
export const TILE_CELLS = TILE_N * TILE_N;
/** Luma at or above this counts as blown out. */
export const SAT_LEVEL = 235;
/** Tiles within this many tiles of a blown-out tile are ignored too (glare has a halo). */
export const SAT_DILATE = 2;
/** The tile streams only run when more than this share of the art window is blown out (tools/wide-ablate.ts: 2 % costs 0.1 point, saves a fifth of the time). */
export const TILE_MIN_BLOWN = 0.02;
/** At least this share of tiles must survive masking for the tile score to mean anything. */
export const MIN_TILE_SHARE = 0.19;

const CX = Math.floor(SHIFT_X.length / 2);
const CY = Math.floor(SHIFT_Y.length / 2);
const at = (a: number, b: number) => a * SHIFT_Y.length + b;
/** Slots (into the 25 shifted grids) used for descriptors and tilings: centre, left, right, up, down. */
export const NEIGHBOUR_SLOTS = [
  at(CX, CY),
  at(CX - 1, CY),
  at(CX + 1, CY),
  at(CX, CY - 1),
  at(CX, CY + 1),
  at(CX - 2, CY),
  at(CX + 2, CY),
  at(CX, CY - 2),
  at(CX, CY + 2),
];
/**
 * Flattened descriptors are smooth, so they are taken at the centre and the four FAR alignments (+/-5.1 % wide, +/-3.9 % high): together with the
 * descriptor's own tolerance that covers a card up to about 8 % off. Tilings are fine-grained, so they use the centre and the four NEAR alignments.
 */
export const FLAT_SLOTS = [0, 5, 6, 7, 8];
export const TILE_SLOTS = 5;
export const CENTRE_SLOT = NEIGHBOUR_SLOTS[0];
export const ALIGNMENTS = SHIFT_X.length * SHIFT_Y.length;

/**
 * Where the art window sat for alignment `a` (an index into the 25 shifted grids), as the (dx, dy) fractions of card size that phash.artRect
 * takes. One half-cell of the 64-cell art window is 0.82/64 of the card width and 0.415/64 of its height (ART_BOX).
 */
export function alignmentOffset(a: number): [number, number] {
  const ix = Math.floor(a / SHIFT_Y.length);
  const iy = a % SHIFT_Y.length;
  return [(SHIFT_X[ix] * (ART_BOX.x1 - ART_BOX.x0)) / 64, (SHIFT_Y[iy] * (ART_BOX.y1 - ART_BOX.y0)) / 64];
}

export interface TileQuery {
  /** tile means, 0-255 */
  q: Float32Array;
  /** 1 where the tile is trusted */
  use: Uint8Array;
  /** number of trusted tiles; 0 when masking left too little */
  n: number;
}

export interface WideQuery {
  /** ALIGNMENTS fingerprints, HASH_WORDS words each */
  hashes: Uint32Array[];
  /** flattened descriptors at the FLAT_SLOTS alignments */
  flat: Float32Array[];
  /** masked tilings per neighbour slot; empty when nothing is blown out (then the tile shortlist is skipped) */
  tiles: TileQuery[];
  /** blown-out share of the art window, for the glare hint */
  blownShare: number;
}

/** Mean-pools a 32x32 grid to TILE_N x TILE_N. */
export function poolTiles(g: Float32Array): Float32Array {
  'worklet';
  const k = 32 / TILE_N;
  const out = new Float32Array(TILE_CELLS);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) out[Math.floor(y / k) * TILE_N + Math.floor(x / k)] += g[y * 32 + x] / (k * k);
  return out;
}

export function tileQuery(g: Float32Array): TileQuery {
  'worklet';
  const k = 32 / TILE_N;
  const sat = new Uint8Array(TILE_CELLS);
  for (let ty = 0; ty < TILE_N; ty++) {
    for (let tx = 0; tx < TILE_N; tx++) {
      let c = 0;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) if (g[(ty * k + y) * 32 + tx * k + x] >= SAT_LEVEL) c++;
      sat[ty * TILE_N + tx] = c >= Math.max(1, (k * k) / 8) ? 1 : 0;
    }
  }
  const use = new Uint8Array(TILE_CELLS).fill(1);
  for (let ty = 0; ty < TILE_N; ty++) {
    for (let tx = 0; tx < TILE_N; tx++) {
      if (!sat[ty * TILE_N + tx]) continue;
      for (let dy = -SAT_DILATE; dy <= SAT_DILATE; dy++) {
        for (let dx = -SAT_DILATE; dx <= SAT_DILATE; dx++) {
          const y = ty + dy;
          const x = tx + dx;
          if (y >= 0 && y < TILE_N && x >= 0 && x < TILE_N) use[y * TILE_N + x] = 0;
        }
      }
    }
  }
  let n = 0;
  for (let i = 0; i < TILE_CELLS; i++) n += use[i];
  if (n < MIN_TILE_SHARE * TILE_CELLS) n = 0;
  return { q: poolTiles(g), use, n };
}

function blownShareOf(g: Float32Array): number {
  'worklet';
  let c = 0;
  for (let i = 0; i < g.length; i++) if (g[i] >= SAT_LEVEL) c++;
  return c / g.length;
}

/**
 * Card sizes relative to the guide at which the art window is also sampled when the card was held too close or too far (see buildWideQuery).
 * Each adds 9 fingerprints (3 x 3 alignments) and one flattened descriptor.
 */
export const SCALE_FACTORS = [0.8, 0.9, 1.12, 1.25];
const SCALE_X = [-2, 0, 2];
const SCALE_Y = [-3, 0, 3];

/** Everything tier 1b needs from one frame. */
export function buildWideQuery(buf: Uint8Array, stride: number, bufW: number, bufH: number, rot: Rotation, card: Rect): WideQuery {
  'worklet';
  const grids = shiftedGrids(buf, stride, bufW, bufH, rot, card);
  const hashes: Uint32Array[] = [];
  for (let i = 0; i < grids.length; i++) hashes.push(phashFromGrid(grids[i]));
  const flat: Float32Array[] = [];
  for (let i = 0; i < FLAT_SLOTS.length; i++) flat.push(describe(grids[NEIGHBOUR_SLOTS[FLAT_SLOTS[i]]], 'flat'));
  const blownShare = blownShareOf(grids[CENTRE_SLOT]);
  const tiles: TileQuery[] = [];
  if (blownShare > TILE_MIN_BLOWN) for (let i = 0; i < TILE_SLOTS; i++) tiles.push(tileQuery(grids[NEIGHBOUR_SLOTS[i]]));
  return { hashes, flat, tiles, blownShare };
}

/**
 * The card held too close or too far: the art window sampled at the card sizes in SCALE_FACTORS (3 x 3 alignments each, 36 fingerprints, 4 descriptors).
 * Built on frames the normal wide search could not use, because it costs about as much as the normal wide query again.
 */
export function buildScaleQuery(buf: Uint8Array, stride: number, bufW: number, bufH: number, rot: Rotation, card: Rect): WideQuery {
  'worklet';
  const hashes: Uint32Array[] = [];
  const flat: Float32Array[] = [];
  for (let k = 0; k < SCALE_FACTORS.length; k++) {
    const s = SCALE_FACTORS[k];
    const scaled = { x: card.x + (card.w * (1 - s)) / 2, y: card.y + (card.h * (1 - s)) / 2, w: card.w * s, h: card.h * s };
    const g9 = shiftedGrids(buf, stride, bufW, bufH, rot, scaled, SCALE_X, SCALE_Y);
    for (let i = 0; i < g9.length; i++) hashes.push(phashFromGrid(g9[i]));
    flat.push(describe(g9[4], 'flat')); // the centre of the 3 x 3
  }
  return { hashes, flat, tiles: [], blownShare: 0 };
}

// --- crossing the worklet boundary as plain numbers -------------------------------------------------------------------

/** Flattens a WideQuery into a plain number array (worklet -> JS). */
export function packWide(q: WideQuery): number[] {
  'worklet';
  const out: number[] = [q.blownShare, q.tiles.length, q.hashes.length, q.flat.length];
  for (const h of q.hashes) for (let k = 0; k < HASH_WORDS; k++) out.push(h[k]);
  for (const d of q.flat) for (let k = 0; k < DESC_LEN; k++) out.push(d[k]);
  for (const t of q.tiles) {
    out.push(t.n);
    for (let k = 0; k < TILE_CELLS; k++) out.push(t.q[k]);
    for (let k = 0; k < TILE_CELLS; k++) out.push(t.use[k]);
  }
  return out;
}

export function unpackWide(a: number[]): WideQuery {
  let p = 0;
  const blownShare = a[p++];
  const nTiles = a[p++];
  const nHashes = a[p++];
  const nFlat = a[p++];
  const hashes: Uint32Array[] = [];
  for (let i = 0; i < nHashes; i++) {
    const h = new Uint32Array(HASH_WORDS);
    for (let k = 0; k < HASH_WORDS; k++) h[k] = a[p++] >>> 0;
    hashes.push(h);
  }
  const flat: Float32Array[] = [];
  for (let i = 0; i < nFlat; i++) {
    flat.push(Float32Array.from(a.slice(p, p + DESC_LEN)));
    p += DESC_LEN;
  }
  const tiles: TileQuery[] = [];
  for (let i = 0; i < nTiles; i++) {
    const n = a[p++];
    const q = Float32Array.from(a.slice(p, p + TILE_CELLS));
    p += TILE_CELLS;
    const use = Uint8Array.from(a.slice(p, p + TILE_CELLS));
    p += TILE_CELLS;
    tiles.push({ q, use, n });
  }
  return { hashes, flat, tiles, blownShare };
}

// --- reference side (catalog builder) ---------------------------------------------------------------------------------

export interface WideRef {
  flat: Int8Array;
  tiles: Uint8Array;
}

const toInt8 = (v: Float32Array) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));

/** Reference descriptors for one illustration's 32x32 art grid (what the catalog stores). */
export function wideRefFromGrid(g: Float32Array): WideRef {
  return {
    flat: toInt8(describe(g, 'flat')),
    tiles: Uint8Array.from(poolTiles(g), (x) => Math.max(0, Math.min(255, Math.round(x)))),
  };
}

/** Bytes per illustration in the catalog's art_desc blob. */
export const WIDE_REF_BYTES = DESC_LEN + TILE_CELLS;

export function packWideRef(r: WideRef): Uint8Array {
  const out = new Uint8Array(WIDE_REF_BYTES);
  out.set(new Uint8Array(r.flat.buffer, r.flat.byteOffset, DESC_LEN), 0);
  out.set(r.tiles, DESC_LEN);
  return out;
}
