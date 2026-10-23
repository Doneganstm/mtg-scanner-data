// Builds and publishes the sealed-product feed (see app/src/lib/sealedFeed.ts). Runs in the data repo's workflow, .github/workflows/sealed.yml.
//
//   node sealed.ts build --out out/sealed [--repo owner/name] [--cache dir] [--prev-dir dir] [--force] [--publish]
//
// 1. Asks TCGCSV when its data was last refreshed (it refreshes once a day, about 20:00 UTC); if that is the moment the previous feed was built from, stops.
// 2. Reads Magic's groups (sets), then every group's products and prices (about 900 small requests, one every 150 ms, with an identifying User-Agent:
//    TCGCSV asks for at most about 1,000 requests for a Magic sync and one sync per day).
// 3. Keeps the sealed products, checks the result looks sane, adds today's prices to the 90-day history.
// 4. With --publish, uploads the files to the release tagged "sealed" (created on first use, never marked "latest" because the card database is fetched
//    from releases/latest). The meta file goes last, so the app never sees a meta that points at files which are not there yet.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SEALED_SCHEMA,
  appendHistory,
  checkSealedHealth,
  extractPrices,
  extractSealed,
  publishCommands,
  toRow,
  type HistoryFile,
  type PricesFile,
  type ProductsFile,
  type RawGroup,
  type RawPrice,
  type RawProduct,
  type SealedMeta,
} from '../app/src/lib/sealedFeed.ts';

const [command, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) args.set(key, '');
  else args.set(key, rest[++i]);
}
const REPO = args.get('repo') ?? process.env.GITHUB_REPOSITORY ?? '';
const OUT = path.resolve(args.get('out') ?? 'out/sealed');
const CACHE = args.get('cache') ? path.resolve(args.get('cache')!) : null;
const PREV_DIR = args.get('prev-dir') ? path.resolve(args.get('prev-dir')!) : null;
const TAG = 'sealed';
const BASE = 'https://tcgcsv.com/tcgplayer';
const UA = { 'User-Agent': 'MtgScannerData/1.0 (+https://github.com/Doneganstm/mtg-scanner-data)' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
const output = (k: string, v: string) => {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};
const summary = (md: string) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  else console.log(md);
};

let requests = 0;
async function getJson<T>(url: string, cacheName?: string): Promise<T> {
  const cached = CACHE && cacheName ? path.join(CACHE, cacheName) : null;
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as T;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(150);
    requests++;
    const res = await fetch(url, { headers: UA });
    if (res.ok) {
      const text = await res.text();
      const body = JSON.parse(text) as { success?: boolean; errors?: unknown[] };
      if (body.success === false) throw new Error(`${url}: ${JSON.stringify(body.errors)}`);
      if (cached) {
        mkdirSync(path.dirname(cached), { recursive: true });
        writeFileSync(cached, text);
      }
      return body as T;
    }
    if (res.status === 404) throw new Error(`${url}: 404`);
    console.log(`retry ${attempt + 1}: ${url} -> ${res.status}`);
    await sleep(res.status === 429 ? 65_000 : 2_000 * (attempt + 1)); // being throttled costs a 10-minute pause; wait it out gently
  }
  throw new Error(`${url}: gave up`);
}

async function sourceUpdated(): Promise<string> {
  const res = await fetch('https://tcgcsv.com/last-updated.txt', { headers: UA });
  if (!res.ok) throw new Error(`last-updated.txt answered ${res.status}`);
  return (await res.text()).trim();
}

async function previous<T>(name: string): Promise<T | null> {
  if (PREV_DIR) {
    const f = path.join(PREV_DIR, name);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : null;
  }
  if (!REPO) return null;
  const res = await fetch(`https://github.com/${REPO}/releases/download/${TAG}/${name}`, { headers: UA });
  if (!res.ok) return null; // the very first run has nothing yet (404)
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function build() {
  const updated = await sourceUpdated();
  const prevMeta = await previous<SealedMeta>('sealed-meta.json');
  if (prevMeta && prevMeta.source_updated_at === updated && !args.has('force')) {
    output('skip', 'true');
    summary(`TCGCSV has not refreshed since ${updated}; nothing to do.`);
    return;
  }
  output('skip', 'false');

  const groups = (await getJson<{ results: RawGroup[] }>(`${BASE}/1/groups`, 'groups.json')).results;
  const productsByGroup = new Map<number, RawProduct[]>();
  const pricesByGroup = new Map<number, RawPrice[]>();
  for (const g of groups) {
    productsByGroup.set(g.groupId, (await getJson<{ results: RawProduct[] }>(`${BASE}/1/${g.groupId}/products`, `p-${g.groupId}.json`)).results ?? []);
    pricesByGroup.set(g.groupId, (await getJson<{ results: RawPrice[] }>(`${BASE}/1/${g.groupId}/prices`, `r-${g.groupId}.json`)).results ?? []);
  }
  console.log(`read ${groups.length} sets with ${requests} requests`);

  const products = extractSealed(groups, productsByGroup);
  const prices = extractPrices(new Set(products.map((p) => p.id)), pricesByGroup);
  const counts = { products: products.length, priced: [...prices.values()].filter((p) => (p.market ?? p.low ?? p.mid) != null).length };
  const health = checkSealedHealth(prevMeta?.counts ?? null, counts);
  if (!health.ok) {
    summary(`## Sealed feed rejected\n${health.problems.map((p) => `- ${p}`).join('\n')}\n\nThe previous feed stays in place.`);
    throw new Error(`sealed feed failed health checks: ${health.problems.join('; ')}`);
  }

  const day = updated.slice(0, 10);
  const builtAt = new Date().toISOString();
  const productsFile: ProductsFile = { schema: SEALED_SCHEMA, built_at: builtAt, products: products.map(toRow) };
  const pricesFile: PricesFile = {
    schema: SEALED_SCHEMA,
    built_at: builtAt,
    date: day,
    prices: Object.fromEntries([...prices].map(([id, p]) => [String(id), [p.market, p.low, p.mid] as [number | null, number | null, number | null]])),
  };
  const historyFile: HistoryFile = appendHistory(await previous<HistoryFile>('sealed-history.json'), day, prices);

  mkdirSync(OUT, { recursive: true });
  const write = (name: string, body: unknown) => {
    const text = JSON.stringify(body);
    writeFileSync(path.join(OUT, name), text);
    return { name, bytes: Buffer.byteLength(text), sha256: sha256(text) };
  };
  // products_version covers only what is in the list (not the build time), so an unchanged list keeps its version and the app skips the download
  const productsVersion = sha256(JSON.stringify(productsFile.products)).slice(0, 12);
  const meta: SealedMeta = {
    schema: SEALED_SCHEMA,
    built_at: builtAt,
    source_updated_at: updated,
    prices_date: day,
    products_version: productsVersion,
    counts,
    files: {
      products: write('sealed-products.json', productsFile),
      prices: write('sealed-prices.json', pricesFile),
      history: write('sealed-history.json', historyFile),
    },
    // the decklists are built by their own weekly job (sealed-decks.ts); the daily meta must not drop them
    decks: prevMeta?.decks ?? null,
  };
  writeFileSync(path.join(OUT, 'sealed-meta.json'), JSON.stringify(meta, null, 1));
  const kb = (f: { bytes: number }) => `${Math.round(f.bytes / 1024)} KB`;
  summary(
    `## Sealed feed built\n- ${counts.products} products (${counts.priced} priced), prices from ${day}\n- products ${kb(meta.files.products)}, prices ${kb(meta.files.prices)}, history ${kb(meta.files.history)} (${historyFile.days.length} days)`,
  );

  if (args.has('publish')) publish();
}

function publish() {
  if (!REPO) throw new Error('--repo is required to publish');
  let exists = true;
  try {
    gh('release', 'view', TAG, '--repo', REPO, '--json', 'tagName');
  } catch {
    exists = false;
  }
  const files = ['sealed-products.json', 'sealed-prices.json', 'sealed-history.json', 'sealed-meta.json'].map((f) => path.join(OUT, f));
  for (const f of files) statSync(f); // all four must exist
  for (const cmd of publishCommands({ repo: REPO, tag: TAG, exists, files })) gh(...cmd);
  summary(`Published ${files.length} files to the "${TAG}" release.`);
}

if (command === 'build') {
  await build();
} else {
  console.error('usage: node sealed.ts build --out out/sealed [--repo owner/name] [--cache dir] [--prev-dir dir] [--force] [--publish]');
  process.exit(2);
}
