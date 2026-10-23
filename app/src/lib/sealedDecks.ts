// Decklists of sealed decks (Commander decks, Planeswalker decks, Challenger decks...), keyed by TCGplayer product id so that scanning a deck's barcode
// leads straight to its cards. Built weekly by the data repo's job (tools/sealed-decks.ts) from MTGJSON; shared by the job and the app, no platform APIs.
//
// MTGJSON's deck file lists every card with its Scryfall id; a deck points at the sealed product it came in (`sealedProductUuids`), and that product,
// in the set's file, carries the TCGplayer product id. A deck file is 0.5 MB with everything MTGJSON knows about each card; compacted to
// [scryfallId, count, flags] it is about 5 KB.

export const DECKS_SCHEMA = 1;

/** MTGJSON deck types worth carrying (real decks you would play or import). Jumpstart packets, Secret Lair drops, MTGO and redemption decks are left out. */
export const DECK_TYPES = [
  'Commander Deck',
  'Planeswalker Deck',
  'Challenger Deck',
  'Pioneer Challenger Deck',
  'Brawl Deck',
  'Starter Deck',
  'Archenemy Deck',
  'Planechase Deck',
  'Event Deck',
  'Premium Deck',
  'Clash Pack',
];

export const FLAG_FOIL = 1;
export const FLAG_ETCHED = 2;
export const FLAG_COMMANDER = 4;
export const FLAG_SIDE = 8;

/** [scryfallId, count, flags] */
export type DeckCard = [string, number, number];

export interface CompactDeck {
  /** name as MTGJSON has it, e.g. "Graveyard Overdrive" */
  n: string;
  /** deck type, e.g. "Commander Deck" */
  t: string;
  /** release date YYYY-MM-DD */
  r: string | null;
  c: DeckCard[];
}

export interface DecksFile {
  schema: number;
  built_at: string;
  /** TCGplayer product id -> deck */
  decks: Record<string, CompactDeck>;
}

export interface DecksMeta {
  name: string;
  bytes: number;
  sha256: string;
  /** changes when the decks change: the app downloads the file again only then */
  version: string;
  count: number;
  /** the products that have a decklist, so the app can show "decklist available" without downloading the file */
  products: number[];
  /** a fingerprint of MTGJSON's deck list the file was built from (the job skips a rebuild when it has not changed) */
  signature: string;
  built_at: string;
}

// ---- reading MTGJSON ---------------------------------------------------------------------------------------------

export interface RawDeckCard {
  count: number;
  isFoil?: boolean;
  isEtched?: boolean;
  identifiers?: { scryfallId?: string };
}
export interface RawDeck {
  name: string;
  type: string;
  releaseDate?: string | null;
  commander?: RawDeckCard[];
  mainBoard?: RawDeckCard[];
  sideBoard?: RawDeckCard[];
  sealedProductUuids?: string[];
}
export interface RawSealedProduct {
  uuid: string;
  category?: string;
  identifiers?: { tcgplayerProductId?: string };
}

/** The deck's cards in compact form. Cards without a Scryfall id (some tokens and oddities) are counted in `skipped`. */
export function compactDeck(raw: RawDeck): { deck: CompactDeck; skipped: number } {
  const merged = new Map<string, DeckCard>();
  let skipped = 0;
  const add = (cards: RawDeckCard[] | undefined, zone: number) => {
    for (const c of cards ?? []) {
      const id = c.identifiers?.scryfallId;
      if (!id || !(c.count >= 1)) {
        skipped += Math.max(0, c.count || 0) || 1;
        continue;
      }
      const flags = (c.isFoil ? FLAG_FOIL : 0) | (c.isEtched ? FLAG_ETCHED : 0) | zone;
      const key = `${id}:${flags}`;
      const cur = merged.get(key);
      if (cur) cur[1] += c.count;
      else merged.set(key, [id, c.count, flags]);
    }
  };
  add(raw.commander, FLAG_COMMANDER);
  add(raw.mainBoard, 0);
  add(raw.sideBoard, FLAG_SIDE);
  return { deck: { n: raw.name, t: raw.type, r: raw.releaseDate ? raw.releaseDate.slice(0, 10) : null, c: [...merged.values()] }, skipped };
}

/**
 * The TCGplayer products a deck came in: the sealed products it points at that are decks (not display boxes or multi-deck sets) and carry a TCGplayer id.
 * `products` is the set file's sealedProduct list, by uuid.
 */
export function productIdsOf(raw: RawDeck, products: Map<string, RawSealedProduct>): number[] {
  const out: number[] = [];
  for (const uuid of raw.sealedProductUuids ?? []) {
    const p = products.get(uuid);
    const id = Number(p?.identifiers?.tcgplayerProductId);
    if (p && p.category === 'deck' && Number.isInteger(id) && id > 0) out.push(id);
  }
  return out;
}

export function deckCardCount(deck: CompactDeck): number {
  return deck.c.reduce((n, c) => n + c[1], 0);
}

/**
 * Builds the file's `decks` from decks and their set's sealed products. A product claimed by two decks keeps the fuller one.
 * Decks with no TCGplayer product, or fewer than `minCards` cards, are left out.
 */
export function linkDecks(items: { deck: RawDeck; products: Map<string, RawSealedProduct> }[], minCards = 20): { decks: Record<string, CompactDeck>; skipped: number; unlinked: string[] } {
  const decks: Record<string, CompactDeck> = {};
  const unlinked: string[] = [];
  let skipped = 0;
  for (const { deck: raw, products } of items) {
    const ids = productIdsOf(raw, products);
    const c = compactDeck(raw);
    skipped += c.skipped;
    if (!ids.length || deckCardCount(c.deck) < minCards) {
      unlinked.push(raw.name);
      continue;
    }
    for (const id of ids) {
      const cur = decks[String(id)];
      if (!cur || deckCardCount(c.deck) > deckCardCount(cur)) decks[String(id)] = c.deck;
    }
  }
  return { decks, skipped, unlinked };
}

/** Stand-in for "has this deck list changed": a fingerprint input built from MTGJSON's DeckList (the job hashes it). */
export function deckListSignature(list: { fileName: string; type: string; releaseDate?: string }[]): string {
  return list
    .filter((d) => DECK_TYPES.includes(d.type))
    .map((d) => `${d.fileName}|${d.type}`)
    .sort()
    .join('\n');
}

// ---- health (job side) -------------------------------------------------------------------------------------------

export function checkDecksHealth(prevCount: number | null, count: number, min = 50): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (count < min) problems.push(`only ${count} decks (expected hundreds)`);
  if (prevCount && count < prevCount * 0.8) problems.push(`${count} decks is more than 20 % fewer than the previous ${prevCount}`);
  return { ok: problems.length === 0, problems };
}

// ---- reading a deck (app side) -------------------------------------------------------------------------------------

export interface DeckLine {
  scryfallId: string;
  count: number;
  foil: boolean;
  etched: boolean;
  commander: boolean;
  side: boolean;
}

export const deckLines = (deck: CompactDeck): DeckLine[] =>
  deck.c.map(([scryfallId, count, f]) => ({ scryfallId, count, foil: !!(f & FLAG_FOIL), etched: !!(f & FLAG_ETCHED), commander: !!(f & FLAG_COMMANDER), side: !!(f & FLAG_SIDE) }));
