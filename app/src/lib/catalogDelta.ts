// Applying a delta database to an installed catalog. A delta (tools/make-delta.ts) holds everything added or changed since the catalog's base:
// new and corrected cards, new artwork fingerprints, price changes, and the new meta rows. It is attached to the installed catalog and merged in
// one transaction, so a failed update leaves the old catalog untouched. Applying a delta twice, or a newer delta on top of an older one, is safe.
//
// Portable SQL only: it runs through expo-sqlite on the phone and node:sqlite in the tests and tools.

export interface DeltaDb {
  execAsync(sql: string): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

/** Columns of `cards` that are not prices, in table order. */
export const CARD_COLUMNS = [
  'id', 'oracle_id', 'illustration_id', 'name', 'name_norm', 'set_code', 'set_name', 'collector_number', 'rarity', 'released_at',
  'type_line', 'mana_cost', 'image', 'finishes', 'usd', 'usd_foil', 'usd_etched', 'eur', 'border_color', 'frame', 'printed_text', 'back_illustration_id',
];
export const NON_PRICE_COLUMNS = CARD_COLUMNS.filter((c) => !['usd', 'usd_foil', 'usd_etched', 'eur'].includes(c));

const SCHEMA = 'delta';

/** The statements that merge the attached delta into the catalog. Exported so the tests can check them in isolation. */
export function mergeStatements(): string[] {
  const cols = CARD_COLUMNS.join(', ');
  return [
    `DELETE FROM main.cards WHERE id IN (SELECT id FROM ${SCHEMA}.removed_cards)`,
    `INSERT OR REPLACE INTO main.cards (${cols}) SELECT ${cols} FROM ${SCHEMA}.cards`,
    `UPDATE main.cards SET usd = p.usd, usd_foil = p.usd_foil, usd_etched = p.usd_etched, eur = p.eur FROM ${SCHEMA}.prices p WHERE p.id = main.cards.id`,
    `DELETE FROM main.art WHERE illustration_id IN (SELECT illustration_id FROM ${SCHEMA}.removed_art)`,
    `DELETE FROM main.art_desc WHERE illustration_id IN (SELECT illustration_id FROM ${SCHEMA}.removed_art)`,
    `DELETE FROM main.art_variant WHERE illustration_id IN (SELECT illustration_id FROM ${SCHEMA}.removed_art)`,
    `INSERT OR REPLACE INTO main.art (illustration_id, hash) SELECT illustration_id, hash FROM ${SCHEMA}.art`,
    `INSERT OR REPLACE INTO main.art_desc (illustration_id, data) SELECT illustration_id, data FROM ${SCHEMA}.art_desc`,
    `INSERT OR REPLACE INTO main.art_variant (illustration_id, variant, hash, data) SELECT illustration_id, variant, hash, data FROM ${SCHEMA}.art_variant`,
    `INSERT INTO main.art_twin (a, b) SELECT t.a, t.b FROM ${SCHEMA}.art_twin t WHERE NOT EXISTS (SELECT 1 FROM main.art_twin x WHERE x.a = t.a AND x.b = t.b)`,
    `INSERT OR REPLACE INTO main.meta (key, value) SELECT key, value FROM ${SCHEMA}.meta WHERE key != 'delta_from_base'`,
  ];
}

export interface DeltaSummary {
  cards: number;
  prices: number;
  art: number;
  builtAt: string;
}

/**
 * Merges the delta database at `deltaPath` (an absolute file path) into the open catalog. Throws, with the catalog unchanged, when the delta does
 * not belong to this catalog (different base or schema) or any statement fails.
 */
export async function applyDelta(db: DeltaDb, deltaPath: string, installed: { base: string; schema: number }): Promise<DeltaSummary> {
  const quoted = deltaPath.replace(/'/g, "''");
  await db.execAsync(`ATTACH DATABASE '${quoted}' AS ${SCHEMA}`);
  try {
    const meta = async (key: string) => (await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${SCHEMA}.meta WHERE key = ?`, key))?.value ?? '';
    const from = await meta('delta_from_base');
    if (!from || from !== installed.base) throw new Error(`delta is for base "${from}", this catalog has "${installed.base}"`);
    if (Number(await meta('schema')) !== installed.schema) throw new Error('delta was built for a different catalog schema');
    const count = async (table: string) => (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${SCHEMA}.${table}`))?.n ?? 0;
    const summary = { cards: await count('cards'), prices: await count('prices'), art: await count('art'), builtAt: await meta('built_at') };
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      for (const sql of mergeStatements()) await db.execAsync(sql);
      await db.execAsync('COMMIT');
    } catch (e) {
      await db.execAsync('ROLLBACK').catch(() => undefined);
      throw e;
    }
    return summary;
  } finally {
    await db.execAsync(`DETACH DATABASE ${SCHEMA}`).catch(() => undefined);
  }
}
