// The SQL that builds a delta database (see catalogDelta.ts for what the app does with it). Runs under Node (tools/make-delta.ts, CI) and in the tests.
import { NON_PRICE_COLUMNS } from './catalogDelta.ts';

export const DELTA_TABLES = ['cards', 'prices', 'removed_cards', 'removed_art', 'art', 'art_desc', 'art_variant', 'art_twin', 'meta'] as const;

const quote = (file: string) => file.split('\\').join('/').replace(/'/g, "''");

/** Statements to run on an EMPTY database; they attach the new and the base catalog and fill the delta tables. */
export function buildDeltaSql(newFile: string, baseFile: string): string {
  const changed = NON_PRICE_COLUMNS.filter((c) => c !== 'id')
    .map((c) => `bc.${c} IS NOT nc.${c}`)
    .join(' OR ');
  return `
    ATTACH DATABASE '${quote(newFile)}' AS n;
    ATTACH DATABASE '${quote(baseFile)}' AS b;
    PRAGMA journal_mode = OFF;
    -- new cards, and cards whose printed data changed (a correction at Scryfall)
    CREATE TABLE main.cards AS SELECT nc.* FROM n.cards nc LEFT JOIN b.cards bc ON bc.id = nc.id WHERE bc.id IS NULL OR ${changed};
    -- price changes of cards both catalogs have
    -- (keyed tables: the merge looks rows up by id)
    CREATE TABLE main.prices (id TEXT PRIMARY KEY, usd REAL, usd_foil REAL, usd_etched REAL, eur REAL) WITHOUT ROWID;
    INSERT INTO main.prices SELECT nc.id, nc.usd, nc.usd_foil, nc.usd_etched, nc.eur FROM n.cards nc JOIN b.cards bc ON bc.id = nc.id
      WHERE bc.usd IS NOT nc.usd OR bc.usd_foil IS NOT nc.usd_foil OR bc.usd_etched IS NOT nc.usd_etched OR bc.eur IS NOT nc.eur;
    CREATE TABLE main.removed_cards (id TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO main.removed_cards SELECT bc.id FROM b.cards bc LEFT JOIN n.cards nc ON nc.id = bc.id WHERE nc.id IS NULL;
    CREATE TABLE main.removed_art (illustration_id TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO main.removed_art SELECT ba.illustration_id FROM b.art ba LEFT JOIN n.art na ON na.illustration_id = ba.illustration_id WHERE na.illustration_id IS NULL;
    CREATE TABLE main.art AS SELECT na.illustration_id, na.hash FROM n.art na LEFT JOIN b.art ba ON ba.illustration_id = na.illustration_id WHERE ba.illustration_id IS NULL OR ba.hash IS NOT na.hash;
    CREATE TABLE main.art_desc AS SELECT nd.illustration_id, nd.data FROM n.art_desc nd LEFT JOIN b.art_desc bd ON bd.illustration_id = nd.illustration_id WHERE bd.illustration_id IS NULL OR bd.data IS NOT nd.data;
    CREATE TABLE main.art_variant AS SELECT nv.illustration_id, nv.variant, nv.hash, nv.data FROM n.art_variant nv
      LEFT JOIN b.art_variant bv ON bv.illustration_id = nv.illustration_id AND bv.variant = nv.variant WHERE bv.illustration_id IS NULL OR bv.hash IS NOT nv.hash OR bv.data IS NOT nv.data;
    CREATE TABLE main.art_twin AS SELECT t.a, t.b FROM n.art_twin t WHERE NOT EXISTS (SELECT 1 FROM b.art_twin x WHERE x.a = t.a AND x.b = t.b);
    CREATE TABLE main.meta AS SELECT key, value FROM n.meta;
    INSERT OR REPLACE INTO main.meta SELECT 'delta_from_base', value FROM b.meta WHERE key = 'base';
    DETACH DATABASE n;
    DETACH DATABASE b;
  `;
}
