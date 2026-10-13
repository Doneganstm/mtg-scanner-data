// Builds out/cards.db: every English paper printing from Scryfall plus a perceptual hash of each
// unique illustration. The app downloads this file; re-run it nightly to refresh prices.
//
//   node build-index.ts [--limit 2000] [--out out] [--concurrency 12]
//
// --limit caps the number of illustrations hashed (for quick dev runs).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, createReadStream, createWriteStream, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import path from 'node:path';
import sharp from 'sharp';
import { artRect, lumaGrid, phashFromGrid } from '../app/src/lib/phash.ts';
import { bytesFromWords } from '../app/src/lib/match.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const LIMIT = args.has('limit') ? Number(args.get('limit')) : Infinity;
const OUT = path.resolve(args.get('out') ?? 'out');
const CONCURRENCY = Number(args.get('concurrency') ?? 12);
const CACHE = path.resolve('cache');
const UA = { 'User-Agent': 'MTGScannerIndexBuilder/1.0', Accept: 'application/json;q=0.9,*/*;q=0.8' };

mkdirSync(OUT, { recursive: true });
mkdirSync(path.join(CACHE, 'small'), { recursive: true });

const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar', 'augment', 'host']);

interface ScryCard {
  id: string;
  oracle_id?: string;
  name: string;
  lang: string;
  layout: string;
  set: string;
  set_name: string;
  set_type: string;
  collector_number: string;
  rarity: string;
  released_at: string;
  type_line?: string;
  mana_cost?: string;
  games: string[];
  finishes?: string[];
  illustration_id?: string;
  image_uris?: { small: string };
  card_faces?: { illustration_id?: string; image_uris?: { small: string }; mana_cost?: string }[];
  prices: { usd: string | null; usd_foil: string | null; usd_etched: string | null; eur: string | null };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

async function downloadBulk(): Promise<ScryCard[]> {
  const file = path.join(CACHE, `default_cards_${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (!existsSync(file)) {
    const meta = (await (await fetch('https://api.scryfall.com/bulk-data/default_cards', { headers: UA })).json()) as {
      download_uri?: string;
      jsonl_download_uri?: string;
    };
    const uri = meta.jsonl_download_uri ?? meta.download_uri;
    if (!uri) throw new Error('Scryfall bulk-data response had no download link');
    console.log('Downloading', uri);
    const res = await fetch(uri, { headers: UA });
    if (!res.ok || !res.body) throw new Error(`bulk download failed: ${res.status}`);
    const gz = uri.endsWith('.gz');
    await pipeline(Readable.fromWeb(res.body as never), ...(gz ? [createGunzip()] : []), createWriteStream(file));
  }
  const out: ScryCard[] = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim().replace(/,$/, '');
    if (!t.startsWith('{')) continue;
    const c = JSON.parse(t) as ScryCard;
    if (c.lang !== 'en' || !c.games?.includes('paper')) continue; // drop early to keep memory low
    out.push({
      id: c.id, oracle_id: c.oracle_id, name: c.name, lang: c.lang, layout: c.layout, set: c.set, set_name: c.set_name,
      set_type: c.set_type, collector_number: c.collector_number, rarity: c.rarity, released_at: c.released_at,
      type_line: c.type_line, mana_cost: c.mana_cost, games: c.games, finishes: c.finishes, illustration_id: c.illustration_id,
      image_uris: c.image_uris ? { small: c.image_uris.small } : undefined,
      card_faces: c.card_faces?.slice(0, 1).map((f) => ({ illustration_id: f.illustration_id, mana_cost: f.mana_cost, image_uris: f.image_uris ? { small: f.image_uris.small } : undefined })),
      prices: c.prices,
    });
  }
  return out;
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function fetchImage(url: string, cacheFile: string): Promise<Buffer> {
  if (existsSync(cacheFile)) return readFileSync(cacheFile);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(cacheFile, buf);
        return buf;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`failed to fetch ${url}`);
}

/** Hash exactly the way the phone does: whole card is the "frame", art window sampled from luma. */
export async function hashCardImage(jpeg: Buffer) {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const card = { x: 0, y: 0, w: info.width, h: info.height };
  const grid = lumaGrid(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width, info.width, info.height, 'up', artRect(card, 0, 0));
  return phashFromGrid(grid);
}

async function main() {
  const all = await downloadBulk();
  console.log(`Scryfall objects: ${all.length}`);
  const cards = all.filter(
    (c) =>
      c.lang === 'en' &&
      c.games?.includes('paper') &&
      !SKIP_LAYOUTS.has(c.layout) &&
      c.set_type !== 'memorabilia' &&
      c.set_type !== 'token' &&
      (c.image_uris ?? c.card_faces?.[0]?.image_uris),
  );
  console.log(`Paper English printings: ${cards.length}`);

  const dbFile = path.join(OUT, 'cards.db');
  rmSync(dbFile, { force: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = OFF;
    CREATE TABLE cards(
      id TEXT PRIMARY KEY, oracle_id TEXT, illustration_id TEXT, name TEXT, name_norm TEXT,
      set_code TEXT, set_name TEXT, collector_number TEXT, rarity TEXT, released_at TEXT,
      type_line TEXT, mana_cost TEXT, image TEXT, finishes TEXT,
      usd REAL, usd_foil REAL, usd_etched REAL, eur REAL
    );
    CREATE TABLE art(illustration_id TEXT PRIMARY KEY, hash BLOB NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
  `);

  const insert = db.prepare(
    'INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const num = (s: string | null | undefined) => (s == null ? null : Number(s));
  const illusImage = new Map<string, string>(); // illustration -> a small-image URL to hash (newest printing wins)
  db.exec('BEGIN');
  for (const c of cards.sort((a, b) => (a.released_at < b.released_at ? 1 : -1))) {
    const face = c.card_faces?.[0];
    const small = (c.image_uris ?? face?.image_uris)!.small;
    const rel = /\/small\/(.+?)(\?|$)/.exec(small)?.[1] ?? '';
    const illus = c.illustration_id ?? face?.illustration_id ?? null;
    if (illus && !illusImage.has(illus)) illusImage.set(illus, small);
    insert.run(
      c.id, c.oracle_id ?? null, illus, c.name, norm(c.name), c.set, c.set_name, c.collector_number,
      c.rarity, c.released_at, c.type_line ?? null, c.mana_cost ?? face?.mana_cost ?? null, rel,
      (c.finishes ?? []).join(','), num(c.prices.usd), num(c.prices.usd_foil), num(c.prices.usd_etched), num(c.prices.eur),
    );
  }
  db.exec('COMMIT');
  db.exec(`
    CREATE INDEX idx_cards_illus ON cards(illustration_id);
    CREATE INDEX idx_cards_name ON cards(name_norm);
    CREATE INDEX idx_cards_set_num ON cards(set_code, collector_number);
    CREATE INDEX idx_cards_oracle ON cards(oracle_id);
  `);

  const illus = [...illusImage.entries()].slice(0, LIMIT);
  console.log(`Hashing ${illus.length} unique illustrations (${CONCURRENCY} parallel)...`);
  const insArt = db.prepare('INSERT INTO art VALUES (?, ?)');
  let done = 0;
  const failed: string[] = [];
  await pool(illus, CONCURRENCY, async ([id, url], i) => {
    try {
      const buf = await fetchImage(url, path.join(CACHE, 'small', `${id}.jpg`));
      insArt.run(id, bytesFromWords(await hashCardImage(buf)));
    } catch (e) {
      failed.push(id);
    }
    if (++done % 500 === 0) console.log(`  ${done}/${illus.length}`);
  });
  if (failed.length) console.warn(`Failed to hash ${failed.length} illustrations`);

  const put = db.prepare('INSERT INTO meta VALUES (?, ?)');
  put.run('built_at', new Date().toISOString());
  put.run('schema', '1');
  put.run('price_date', new Date().toISOString().slice(0, 10));
  put.run('illustrations', String(done - failed.length));
  put.run('printings', String(cards.length));
  db.exec('VACUUM');
  db.close();
  console.log(`Wrote ${dbFile}`);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-index.ts')) {
  await main();
}
