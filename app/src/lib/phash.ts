// Perceptual hashing shared by the phone (frame worklet) and the index builder (Node).
// Every function is a worklet and only touches its arguments, so it can run on any runtime.
// Keep this file free of imports: tools/build-index.ts loads it directly with Node.

export const HASH_BYTES = 32; // 16x16 low-frequency DCT block -> 256 bits
export const HASH_WORDS = 8; // same, as 32-bit words

/** Art window as fractions of the full card; slightly inside the printed art box. */
export const ART_BOX = { x0: 0.09, y0: 0.125, x1: 0.91, y1: 0.54 };

/** Physical card aspect (63 x 88 mm). */
export const CARD_ASPECT = 63 / 88;

export type Rotation = 'up' | 'right' | 'down' | 'left';
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 32;
const BLOCK = 16;

/**
 * Box-averages a region of an 8-bit luma image into a GRID x GRID float grid.
 * `rect` is in "upright" coordinates; `rot` says how the stored buffer must be rotated to be upright.
 */
export function lumaGrid(
  buf: Uint8Array,
  stride: number,
  bufW: number,
  bufH: number,
  rot: Rotation,
  rect: Rect,
): Float32Array {
  'worklet';
  const out = new Float32Array(GRID * GRID);
  const cellW = rect.w / GRID;
  const cellH = rect.h / GRID;
  const taps = 3;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let sum = 0;
      for (let ty = 0; ty < taps; ty++) {
        for (let tx = 0; tx < taps; tx++) {
          const ux = Math.floor(rect.x + (gx + (tx + 0.5) / taps) * cellW);
          const uy = Math.floor(rect.y + (gy + (ty + 0.5) / taps) * cellH);
          let bx = ux;
          let by = uy;
          if (rot === 'right') {
            bx = uy;
            by = bufH - 1 - ux;
          } else if (rot === 'down') {
            bx = bufW - 1 - ux;
            by = bufH - 1 - uy;
          } else if (rot === 'left') {
            bx = bufW - 1 - uy;
            by = ux;
          }
          if (bx < 0) bx = 0;
          else if (bx >= bufW) bx = bufW - 1;
          if (by < 0) by = 0;
          else if (by >= bufH) by = bufH - 1;
          sum += buf[by * stride + bx];
        }
      }
      out[gy * GRID + gx] = sum / (taps * taps);
    }
  }
  return out;
}

/** One luma sample at upright coordinates (ux, uy), clamped to the image; `rot` as in lumaGrid. */
export function lumaAt(buf: Uint8Array, stride: number, bufW: number, bufH: number, rot: Rotation, ux: number, uy: number): number {
  'worklet';
  let bx = Math.floor(ux);
  let by = Math.floor(uy);
  if (rot === 'right') {
    bx = Math.floor(uy);
    by = bufH - 1 - Math.floor(ux);
  } else if (rot === 'down') {
    bx = bufW - 1 - Math.floor(ux);
    by = bufH - 1 - Math.floor(uy);
  } else if (rot === 'left') {
    bx = bufW - 1 - Math.floor(uy);
    by = Math.floor(ux);
  }
  if (bx < 0) bx = 0;
  else if (bx >= bufW) bx = bufW - 1;
  if (by < 0) by = 0;
  else if (by >= bufH) by = bufH - 1;
  return buf[by * stride + bx];
}

/** Mean absolute neighbour difference of a grid: a cheap sharpness / "is there a textured card here" score. */
export function gridDetail(grid: Float32Array): number {
  'worklet';
  let acc = 0;
  let n = 0;
  for (let y = 0; y < GRID - 1; y++) {
    for (let x = 0; x < GRID - 1; x++) {
      const v = grid[y * GRID + x];
      acc += Math.abs(v - grid[y * GRID + x + 1]) + Math.abs(v - grid[(y + 1) * GRID + x]);
      n += 2;
    }
  }
  return acc / n;
}

/** 256-bit DCT perceptual hash of a GRID x GRID luma grid, packed as 8 little-endian uint32 words. */
export function phashFromGrid(grid: Float32Array): Uint32Array {
  'worklet';
  const cosT = new Float32Array(BLOCK * GRID); // cosT[u*GRID + x]
  for (let u = 0; u < BLOCK; u++) {
    for (let x = 0; x < GRID; x++) {
      cosT[u * GRID + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * GRID));
    }
  }
  // Row transform: keep the first BLOCK frequencies of each row.
  const rows = new Float32Array(GRID * BLOCK);
  for (let y = 0; y < GRID; y++) {
    for (let u = 0; u < BLOCK; u++) {
      let s = 0;
      for (let x = 0; x < GRID; x++) s += grid[y * GRID + x] * cosT[u * GRID + x];
      rows[y * BLOCK + u] = s;
    }
  }
  // Column transform.
  const coef = new Float32Array(BLOCK * BLOCK);
  for (let v = 0; v < BLOCK; v++) {
    for (let u = 0; u < BLOCK; u++) {
      let s = 0;
      for (let y = 0; y < GRID; y++) s += rows[y * BLOCK + u] * cosT[v * GRID + y];
      coef[v * BLOCK + u] = s;
    }
  }
  // Median of AC coefficients (DC excluded) is the threshold.
  const sorted = new Float32Array(BLOCK * BLOCK - 1);
  for (let i = 1; i < BLOCK * BLOCK; i++) sorted[i - 1] = coef[i];
  sorted.sort();
  const median = sorted[sorted.length >> 1];
  const words = new Uint32Array(HASH_WORDS);
  for (let i = 0; i < BLOCK * BLOCK; i++) {
    if (coef[i] > median) words[i >> 5] |= (1 << (i & 31)) >>> 0;
  }
  return words;
}

/** Art window of a card whose bounding box (upright coords) is `card`, nudged by (dx, dy) fractions of card size. */
export function artRect(card: Rect, dx: number, dy: number): Rect {
  'worklet';
  return {
    x: card.x + (ART_BOX.x0 + dx) * card.w,
    y: card.y + (ART_BOX.y0 + dy) * card.h,
    w: (ART_BOX.x1 - ART_BOX.x0) * card.w,
    h: (ART_BOX.y1 - ART_BOX.y0) * card.h,
  };
}

/** Where the on-screen guide rectangle lands in the (cover-fitted) camera frame. */
export function guideToFrame(
  screenW: number,
  screenH: number,
  frameW: number,
  frameH: number,
  guide: Rect,
): Rect {
  'worklet';
  const s = Math.max(screenW / frameW, screenH / frameH);
  const ox = (screenW - frameW * s) / 2;
  const oy = (screenH - frameH * s) / 2;
  return { x: (guide.x - ox) / s, y: (guide.y - oy) / s, w: guide.w / s, h: guide.h / s };
}

export function popcount32(v: number): number {
  'worklet';
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** The on-screen card outline (screen coordinates). The UI draws it and the frame worklet samples it. */
export function computeGuide(screenW: number, screenH: number): Rect {
  'worklet';
  let w = screenW * 0.84;
  let h = w / CARD_ASPECT;
  if (h > screenH * 0.58) {
    h = screenH * 0.58;
    w = h * CARD_ASPECT;
  }
  return { x: (screenW - w) / 2, y: (screenH - h) / 2 - screenH * 0.1, w, h };
}
