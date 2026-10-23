// Sealed products (booster boxes, bundles, decks...) and their prices.
//
// The data repo's daily job turns TCGCSV (a daily copy of TCGplayer's catalogue and prices) into four small files that the app reads:
//   sealed-meta.json      what exists, when it was built, sizes and checksums (the only file the app asks for every day)
//   sealed-products.json  the product list; changes only when TCGplayer lists something new
//   sealed-prices.json    today's market / low / mid price per product
//   sealed-history.json   about 90 days of prices per product, for the chart
// This module is shared by the job (Node) and the app, so it uses no platform APIs.

import type { DecksMeta } from './sealedDecks';

export const SEALED_SCHEMA = 1;
export const SEALED_HISTORY_DAYS = 90;

export type SealedKind = 'box' | 'case' | 'pack' | 'bundle' | 'deck' | 'kit' | 'lair' | 'other';
export const SEALED_KINDS: SealedKind[] = ['box', 'case', 'pack', 'bundle', 'deck', 'kit', 'lair', 'other'];
export const SEALED_KIND_LABEL: Record<SealedKind, string> = {
  box: 'Boxes',
  case: 'Cases',
  pack: 'Packs',
  bundle: 'Bundles',
  deck: 'Decks',
  kit: 'Kits',
  lair: 'Secret Lair',
  other: 'Other',
};
export const SEALED_KIND_SINGULAR: Record<SealedKind, string> = {
  box: 'Box',
  case: 'Case',
  pack: 'Pack',
  bundle: 'Bundle',
  deck: 'Deck',
  kit: 'Kit',
  lair: 'Secret Lair',
  other: 'Other',
};

export interface SealedProduct {
  /** TCGplayer product id */
  id: number;
  name: string;
  /** TCGplayer set abbreviation, e.g. MH3 (may be empty) */
  set: string;
  setName: string;
  /** YYYY-MM-DD, when TCGplayer says the set came out */
  released: string | null;
  kind: SealedKind;
  upc: string | null;
}

export interface SealedPrice {
  market: number | null;
  low: number | null;
  mid: number | null;
}

/** [id, name, set, setName, released, kind, upc] */
export type ProductRow = [number, string, string, string, string | null, SealedKind, string | null];

export interface ProductsFile {
  schema: number;
  built_at: string;
  products: ProductRow[];
}

export interface PricesFile {
  schema: number;
  built_at: string;
  /** the day the prices are from (UTC date of TCGCSV's last-updated.txt) */
  date: string;
  /** id -> [market, low, mid] */
  prices: Record<string, [number | null, number | null, number | null]>;
}

export interface HistoryFile {
  schema: number;
  /** the days that have a point, oldest first */
  days: string[];
  /** id -> prices aligned to the END of `days` (a product listed later has a shorter series); null = no price that day */
  h: Record<string, (number | null)[]>;
}

export interface SealedMeta {
  schema: number;
  built_at: string;
  /** TCGCSV's last-updated.txt the data was built from */
  source_updated_at: string;
  prices_date: string;
  /** changes when the product list changes; the app downloads sealed-products.json only when it differs from the one it has */
  products_version: string;
  counts: { products: number; priced: number };
  files: Record<'products' | 'prices' | 'history', { name: string; bytes: number; sha256: string }>;
  /** the decklists file (built weekly by a separate job; the daily build carries this over unchanged), see sealedDecks.ts */
  decks?: DecksMeta | null;
}

// ---- reading TCGCSV ----------------------------------------------------------------------------------------

export interface RawGroup {
  groupId: number;
  name: string;
  abbreviation?: string | null;
  publishedOn?: string | null;
}
export interface RawProduct {
  productId: number;
  name: string;
  groupId: number;
  extendedData?: { name: string; value: string }[];
  presaleInfo?: { releasedOn?: string | null } | null;
}
export interface RawPrice {
  productId: number;
  lowPrice?: number | null;
  midPrice?: number | null;
  marketPrice?: number | null;
  subTypeName?: string | null;
}

const has = (p: RawProduct, key: string) => (p.extendedData ?? []).some((e) => e.name === key);

/**
 * Things that have no Rarity or Number on TCGplayer but are not sealed product: digital codes, and single promo cards listed without a rarity
 * (metal-promo tokens and emblems, box toppers), plus merchandise.
 */
const NOT_SEALED = /\b(code card|online code|digital code|arena code|mtgo code|redemption)\b|\(metal promo\)|^emblem\b|\bbox topper\b|\bsneakers\b/i;

/**
 * TCGplayer has no "sealed" flag, but every single card carries a Rarity or a Number and no sealed product does
 * (checked against all of Magic on 2026-10-22: 3,775 of 119,528 products have neither; the 15 odd ones are named in NOT_SEALED).
 */
export function isSealed(p: RawProduct): boolean {
  return !has(p, 'Rarity') && !has(p, 'Number') && !NOT_SEALED.test(p.name);
}

/** A rough class for filtering; the product name is always shown as TCGplayer wrote it, so a wrong guess only affects the filter chips. */
export function kindOf(name: string): SealedKind {
  const n = name.toLowerCase();
  if (/secret lair/.test(n)) return 'lair';
  if (/\bcase\b/.test(n)) return 'case';
  if (/\b(bundle|fat pack)\b/.test(n)) return 'bundle';
  if (/(booster|draft|set|play|collector|jumpstart|theme|prerelease)[ -]*(box|display)\b|\bdisplay\b|\b(box|display)$/.test(n)) return 'box';
  if (/\bbooster\b/.test(n)) return 'pack'; // before decks: "Commander Legends - Draft Booster Pack" is a pack
  if (/prerelease|starter kit|welcome|launch party|promo pack|\bkit\b|draft night/.test(n)) return 'kit';
  if (/\bdecks?\b|\bintro pack\b|\bprecon\b|\bcommander 20\d\d\b/.test(n)) return 'deck';
  if (/\bpack\b/.test(n)) return 'pack';
  return 'other';
}

const dateOnly = (s?: string | null) => (s ? s.slice(0, 10) : null);

/** Sealed products of every group, in a stable order (newest sets first, then name). */
export function extractSealed(groups: RawGroup[], productsByGroup: Map<number, RawProduct[]>): SealedProduct[] {
  const out: SealedProduct[] = [];
  const seen = new Set<number>();
  for (const g of groups) {
    for (const p of productsByGroup.get(g.groupId) ?? []) {
      if (seen.has(p.productId) || !isSealed(p)) continue;
      seen.add(p.productId);
      out.push({
        id: p.productId,
        name: p.name.trim(),
        set: g.abbreviation ?? '',
        setName: g.name,
        released: dateOnly(p.presaleInfo?.releasedOn) ?? dateOnly(g.publishedOn),
        kind: kindOf(p.name),
        upc: (p.extendedData ?? []).find((e) => e.name === 'UPC')?.value?.trim() || null,
      });
    }
  }
  return out.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name) || a.id - b.id);
}

const money = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);

/** One price per product (TCGplayer lists a row per printing; sealed products have just "Normal"). */
export function extractPrices(ids: Set<number>, pricesByGroup: Map<number, RawPrice[]>): Map<number, SealedPrice> {
  const out = new Map<number, SealedPrice>();
  for (const rows of pricesByGroup.values()) {
    for (const r of rows) {
      if (!ids.has(r.productId)) continue;
      const price = { market: money(r.marketPrice), low: money(r.lowPrice), mid: money(r.midPrice) };
      const cur = out.get(r.productId);
      // keep the "Normal" row when there are several; otherwise the first with any price
      if (!cur || (r.subTypeName === 'Normal' && (price.market ?? price.low ?? price.mid) != null)) out.set(r.productId, price);
    }
  }
  return out;
}

// ---- reading the feed --------------------------------------------------------------------------------------------

export type PriceBasis = 'market' | 'low' | 'mid' | 'manual';
export const BASIS_LABEL: Record<PriceBasis, string> = {
  market: 'TCGplayer market price',
  low: 'lowest TCGplayer listing',
  mid: 'median TCGplayer listing',
  manual: 'your own price',
};

/** The market price is TCGplayer's estimate of recent sales; for slow-moving products it can be missing, then the lowest or median listing stands in. */
export function bestPrice(p: SealedPrice | null | undefined): { price: number; basis: PriceBasis } | null {
  if (!p) return null;
  if (p.market != null) return { price: p.market, basis: 'market' };
  if (p.low != null) return { price: p.low, basis: 'low' };
  if (p.mid != null) return { price: p.mid, basis: 'mid' };
  return null;
}

export const toProduct = (r: ProductRow): SealedProduct => ({ id: r[0], name: r[1], set: r[2], setName: r[3], released: r[4], kind: r[5], upc: r[6] });
export const toRow = (p: SealedProduct): ProductRow => [p.id, p.name, p.set, p.setName, p.released, p.kind, p.upc];

export const productImage = (id: number, size: 'small' | 'large' = 'small') => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_${size === 'small' ? '200w' : '400w'}.jpg`;

export const normSealed = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Every word of the query must appear (in the name, set name or abbreviation); names that start with the query and whole-word hits rank first. */
export function searchSealed(products: SealedProduct[], query: string, opts: { kind?: SealedKind | null; limit?: number } = {}): SealedProduct[] {
  const q = normSealed(query);
  const words = q ? q.split(' ') : [];
  const limit = opts.limit ?? 60;
  const scored: { p: SealedProduct; score: number }[] = [];
  for (const p of products) {
    if (opts.kind && p.kind !== opts.kind) continue;
    if (!words.length) {
      scored.push({ p, score: 0 });
      if (scored.length >= limit) break;
      continue;
    }
    const hay = normSealed(`${p.name} ${p.setName} ${p.set}`);
    if (!words.every((w) => hay.includes(w))) continue;
    const name = normSealed(p.name);
    let score = 0;
    if (name.startsWith(q)) score += 4;
    if (words.every((w) => ` ${hay} `.includes(` ${w} `))) score += 2;
    if (p.upc && q.length >= 8 && normalizeUpc(p.upc) === normalizeUpc(query)) score += 10;
    scored.push({ p, score });
  }
  // newest first is the products' own order, so a stable sort by score keeps it within each score
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.p);
}

/**
 * A barcode's digits without leading zeros: a UPC-A is 12 digits, scanners often report the same code as a 13-digit EAN with a 0 in front, and some
 * report a 14-digit GTIN, so codes are compared without the padding.
 */
export const normalizeUpc = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');

/**
 * Every product with this barcode. Wizards puts one UPC on a whole line of products (the four Commander decks of a set share one, the four Collector's
 * Edition decks another), so a code often matches several products and the person has to say which they hold. Checked 2026-10-22 against TCGplayer's list:
 * 1,074 of 3,754 sealed products have a barcode at all, and 119 of the 800 distinct barcodes belong to more than one product (393 products).
 */
export function findAllByUpc(products: SealedProduct[], upc: string): SealedProduct[] {
  const n = normalizeUpc(upc);
  if (n.length < 6) return []; // too short to be a product barcode
  return products.filter((p) => !!p.upc && normalizeUpc(p.upc) === n);
}

/**
 * For choosing between similar products: the part of each name that tells them apart (the words they do not all start with), and the shared start.
 * "Modern Horizons 3 Commander Deck - Creative Energy" next to "... - Tricky Terrain" gives "Creative Energy" and "Tricky Terrain".
 */
export function distinguishNames(names: string[]): { title: string; context: string }[] {
  if (names.length < 2) return names.map((n) => ({ title: n, context: '' }));
  const tokens = names.map((n) => n.trim().split(/\s+/));
  const min = Math.min(...tokens.map((t) => t.length));
  let k = 0;
  while (k < min - 1 && tokens.every((t) => t[k] === tokens[0][k])) k++; // never use up a whole name
  const clean = (s: string) => s.replace(/^[\s\-–:]+|[\s\-–:]+$/g, '');
  const context = clean(tokens[0].slice(0, k).join(' '));
  return tokens.map((t) => ({ title: clean(t.slice(k).join(' ')) || t.join(' '), context }));
}

/** The product with this barcode, only when it is the one and only: a shared barcode does not say which product it is. */
export function findByUpc(products: SealedProduct[], upc: string): SealedProduct | null {
  const all = findAllByUpc(products, upc);
  return all.length === 1 ? all[0] : null;
}

// ---- building the history file (job side) ----------------------------------------------------------------------------

/** Adds today's prices to the history, keeping the last `keep` days. Running twice for the same day replaces that day's point. */
export function appendHistory(prev: HistoryFile | null, day: string, prices: Map<number, SealedPrice>, keep = SEALED_HISTORY_DAYS): HistoryFile {
  const days = [...(prev?.days ?? [])];
  const h: Record<string, (number | null)[]> = {};
  for (const [id, series] of Object.entries(prev?.h ?? {})) h[id] = [...series];
  const same = days[days.length - 1] === day;
  if (same) {
    days.pop();
    for (const id of Object.keys(h)) h[id].pop();
  }
  days.push(day);
  const ids = new Set<string>([...Object.keys(h), ...[...prices.keys()].map(String)]);
  for (const id of ids) {
    const series = h[id] ?? [];
    // a series is aligned to the end of the days list: pad products that were absent earlier days with nothing, and absent today with null
    const bp = bestPrice(prices.get(Number(id)));
    series.push(bp ? bp.price : null);
    h[id] = series;
  }
  const drop = Math.max(0, days.length - keep);
  if (drop) {
    days.splice(0, drop);
    for (const id of Object.keys(h)) h[id] = h[id].slice(Math.max(0, h[id].length - days.length));
  }
  // forget products that have no price in the whole window
  for (const id of Object.keys(h)) if (h[id].every((v) => v == null)) delete h[id];
  return { schema: SEALED_SCHEMA, days, h };
}

/** A product's series with its dates, for charting. */
export function seriesOf(history: HistoryFile | null, id: number): { date: string; price: number }[] {
  const s = history?.h[String(id)];
  if (!history || !s) return [];
  const offset = history.days.length - s.length;
  const out: { date: string; price: number }[] = [];
  s.forEach((v, i) => {
    if (v != null) out.push({ date: history.days[offset + i], price: v });
  });
  return out;
}

/** Two dated series as one, oldest first; where both have a point for a day the second one (what the phone recorded itself) wins. */
export function mergeSeries(feed: { date: string; price: number }[], own: { date: string; price: number }[]): { date: string; price: number }[] {
  const m = new Map<string, number>();
  for (const p of feed) m.set(p.date, p.price);
  for (const p of own) m.set(p.date, p.price);
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([date, price]) => ({ date, price }));
}

// ---- publishing (job side) -----------------------------------------------------------------------------------------

/**
 * The `gh` commands that publish the feed to the release tagged `tag`, in order.
 *  - the release is created on first use as a pre-release that is explicitly not "latest": the app downloads the card database from
 *    releases/latest, so this release must never take that place;
 *  - assets are replaced in place (--clobber) so the download addresses never change;
 *  - sealed-meta.json goes last, so a phone never reads a meta that points at files which have not been uploaded yet.
 */
export function publishCommands(opts: { repo: string; tag: string; exists: boolean; files: string[] }): string[][] {
  const isMeta = (f: string) => /(^|[\\/])sealed-meta\.json$/.test(f);
  const files = [...opts.files.filter((f) => !isMeta(f)), ...opts.files.filter(isMeta)];
  const cmds: string[][] = [];
  if (!opts.exists) {
    cmds.push([
      'release', 'create', opts.tag, '--repo', opts.repo, '--title', 'Sealed products and prices', '--latest=false', '--prerelease',
      '--notes', 'Rebuilt daily from TCGCSV (a daily copy of TCGplayer prices). The app reads sealed-meta.json first.',
    ]);
  }
  for (const f of files) cmds.push(['release', 'upload', opts.tag, f, '--repo', opts.repo, '--clobber']);
  return cmds;
}

// ---- health (job side) -------------------------------------------------------------------------------------------

export function checkSealedHealth(prev: { products: number; priced: number } | null, next: { products: number; priced: number }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (next.products < 1500) problems.push(`only ${next.products} sealed products (expected thousands)`);
  if (next.products > 0 && next.priced / next.products < 0.5) problems.push(`only ${next.priced} of ${next.products} sealed products have a price`);
  if (prev && prev.products > 0 && next.products < prev.products * 0.9) problems.push(`${next.products} products is more than 10 % fewer than the previous ${prev.products}`);
  if (prev && prev.priced > 0 && next.priced < prev.priced * 0.8) problems.push(`${next.priced} priced products is more than 20 % fewer than the previous ${prev.priced}`);
  return { ok: problems.length === 0, problems };
}
