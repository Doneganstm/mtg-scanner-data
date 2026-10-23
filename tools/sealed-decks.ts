// Builds and publishes the decklists of sealed decks (see app/src/lib/sealedDecks.ts). Runs weekly in the data repo's workflow, .github/workflows/sealed-decks.yml.
//
//   node sealed-decks.ts build --out out/sealed [--repo owner/name] [--prev-dir dir] [--force] [--publish]
//        [--decklist DeckList.json] [--decks-dir AllDeckFiles/..] [--sets-dir AllSetFiles/..]     (use files you already have)
//        [--decks-archive path-or-url] [--sets-archive path-or-url]                                 (use other archives than MTGJSON's)
//
// 1. Reads MTGJSON's DeckList (650 KB) and keeps the deck types in DECK_TYPES. Stops when that list is what the published decks file was built from
//    (and it is less than four weeks old), so most weeks cost one small request.
// 2. Otherwise streams MTGJSON's two bulk archives (AllSetFiles 180 MB, AllDeckFiles 260 MB, one request each, the way MTGJSON offers them) through
//    tar, extracting only the files needed. No per-deck requests.
// 3. For each deck: the sealed product it came in (from its set's file) gives the TCGplayer product id; the deck is compacted to scryfall ids and counts.
// 4. Writes sealed-decks.json and the published sealed-meta.json with its `decks` entry patched in, and with --publish uploads both (the meta file last).
//    The daily build (sealed.ts) carries the `decks` entry over. A first sealed build must exist: this job only adds to its meta file.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  DECKS_SCHEMA,
  DECK_TYPES,
  checkDecksHealth,
  deckListSignature,
  linkDecks,
  type DecksFile,
  type DecksMeta,
  type RawDeck,
  type RawSealedProduct,
} from '../app/src/lib/sealedDecks.ts';
import { publishCommands, type SealedMeta } from '../app/src/lib/sealedFeed.ts';

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
const PREV_DIR = args.get('prev-dir') ? path.resolve(args.get('prev-dir')!) : null;
const TAG = 'sealed';
const MTGJSON = 'https://mtgjson.com/api/v5';
const UA = { 'User-Agent': 'MtgScannerData/1.0 (+https://github.com/Doneganstm/mtg-scanner-data)' };
const FOUR_WEEKS = 28 * 86400000;

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const output = (k: string, v: string) => {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};
const summary = (md: string) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  else console.log(md);
};

async function previousMeta(): Promise<SealedMeta | null> {
  if (PREV_DIR) {
    const f = path.join(PREV_DIR, 'sealed-meta.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as SealedMeta) : null;
  }
  if (!REPO) return null;
  const res = await fetch(`https://github.com/${REPO}/releases/download/${TAG}/sealed-meta.json`, { headers: UA });
  return res.ok ? ((await res.json()) as SealedMeta) : null;
}

/** Streams a .tar.gz (a URL or a local file) through `tar`, extracting only the listed members into `dir`. */
async function extract(source: string, dir: string, members: string[]) {
  mkdirSync(dir, { recursive: true });
  const list = path.join(dir, '.members.txt');
  writeFileSync(list, members.join('\n') + '\n');
  const tar = spawn('tar', ['-xzf', '-', '-C', dir, '-T', list], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<void>((resolve, reject) => {
    tar.on('error', reject);
    // tar exits non-zero when a listed member is not in the archive (a deck MTGJSON lists but has no file for); the rest is still extracted, and the
    // health check below catches a run that extracted too little
    tar.on('close', (code) => {
      if (code) console.log(`tar exited with ${code} (some listed files were not in the archive)`);
      resolve();
    });
  });
  let body: Readable;
  if (/^https?:/.test(source)) {
    const res = await fetch(source, { headers: UA });
    if (!res.ok || !res.body) throw new Error(`${source} answered ${res.status}`);
    body = Readable.fromWeb(res.body as never);
  } else {
    body = createReadStream(source);
  }
  await Promise.all([pipeline(body, tar.stdin), done]);
}

async function build() {
  const listFile = args.get('decklist');
  const deckList = (listFile ? JSON.parse(readFileSync(listFile, 'utf8')) : await (await fetch(`${MTGJSON}/DeckList.json`, { headers: UA })).json()) as {
    data: { code: string; fileName: string; name: string; type: string; releaseDate?: string }[];
  };
  const wanted = deckList.data.filter((d) => DECK_TYPES.includes(d.type));
  const signature = sha256(deckListSignature(wanted));

  const prev = await previousMeta();
  if (!prev) throw new Error('there is no published sealed feed yet: run the sealed build (sealed.ts) first, this job adds its decks entry to that meta file');
  const fresh = prev.decks && Date.now() - Date.parse(prev.decks.built_at) < FOUR_WEEKS;
  if (prev.decks?.signature === signature && fresh && !args.has('force')) {
    output('skip', 'true');
    summary(`MTGJSON's deck list has not changed since the decks were built (${prev.decks.built_at}); nothing to do.`);
    return;
  }
  output('skip', 'false');

  // ---- files
  const tmp = args.get('decks-dir') && args.get('sets-dir') ? null : mkdtempSync(path.join(tmpdir(), 'sealed-decks-'));
  try {
    const codes = [...new Set(wanted.map((d) => d.code))];
    let decksDir = args.get('decks-dir') ? path.resolve(args.get('decks-dir')!) : '';
    let setsDir = args.get('sets-dir') ? path.resolve(args.get('sets-dir')!) : '';
    if (tmp) {
      console.log(`extracting ${codes.length} set files and ${wanted.length} deck files from MTGJSON's archives…`);
      setsDir = path.join(tmp, 'sets');
      decksDir = path.join(tmp, 'decks');
      await extract(args.get('sets-archive') ?? `${MTGJSON}/AllSetFiles.tar.gz`, setsDir, codes.map((c) => `AllSetFiles/${c}.json`));
      await extract(args.get('decks-archive') ?? `${MTGJSON}/AllDeckFiles.tar.gz`, decksDir, wanted.map((d) => `AllDeckFiles/${d.fileName}.json`));
      setsDir = path.join(setsDir, 'AllSetFiles');
      decksDir = path.join(decksDir, 'AllDeckFiles');
    }

    // ---- link and compact, one set at a time (set files can be tens of MB)
    const items: { deck: RawDeck; products: Map<string, RawSealedProduct> }[] = [];
    for (const code of codes) {
      const setFile = path.join(setsDir, `${code}.json`);
      if (!existsSync(setFile)) {
        console.log(`no set file for ${code}`);
        continue;
      }
      const set = (JSON.parse(readFileSync(setFile, 'utf8')) as { data: { sealedProduct?: RawSealedProduct[] } }).data;
      const products = new Map((set.sealedProduct ?? []).map((p) => [p.uuid, { uuid: p.uuid, category: p.category, identifiers: p.identifiers }] as const));
      for (const d of wanted.filter((x) => x.code === code)) {
        const f = path.join(decksDir, `${d.fileName}.json`);
        if (!existsSync(f)) {
          console.log(`no deck file for ${d.fileName}`);
          continue;
        }
        items.push({ deck: (JSON.parse(readFileSync(f, 'utf8')) as { data: RawDeck }).data, products });
      }
    }
    const { decks, skipped, unlinked } = linkDecks(items);
    const count = Object.keys(decks).length;
    const health = checkDecksHealth(prev.decks?.count ?? null, count, args.has('min-decks') ? Number(args.get('min-decks')) : 50);
    if (!health.ok) {
      summary(`## Decks rejected\n${health.problems.map((p) => `- ${p}`).join('\n')}\n\nThe previous decks stay in place.`);
      throw new Error(`decks failed health checks: ${health.problems.join('; ')}`);
    }

    // ---- write
    mkdirSync(OUT, { recursive: true });
    const builtAt = new Date().toISOString();
    const file: DecksFile = { schema: DECKS_SCHEMA, built_at: builtAt, decks };
    const text = JSON.stringify(file);
    writeFileSync(path.join(OUT, 'sealed-decks.json'), text);
    const meta: DecksMeta = {
      name: 'sealed-decks.json',
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      // the version covers the decks, not the build time, so an unchanged result keeps its version and phones skip the download
      version: sha256(JSON.stringify(decks)).slice(0, 12),
      count,
      products: Object.keys(decks).map(Number).sort((a, b) => a - b),
      signature,
      built_at: builtAt,
    };
    writeFileSync(path.join(OUT, 'sealed-meta.json'), JSON.stringify({ ...prev, decks: meta }, null, 1));
    summary(
      `## Sealed decks built\n- ${count} decks for TCGplayer products (${(meta.bytes / 1024).toFixed(0)} KB), ${unlinked.length} decks without a TCGplayer product, ${skipped} cards without a Scryfall id`,
    );

    if (args.has('publish')) {
      if (!REPO) throw new Error('--repo is required to publish');
      const files = [path.join(OUT, 'sealed-decks.json'), path.join(OUT, 'sealed-meta.json')];
      for (const f of files) statSync(f);
      for (const cmd of publishCommands({ repo: REPO, tag: TAG, exists: true, files })) gh(...cmd);
      summary(`Published the decks to the "${TAG}" release.`);
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (command === 'build') {
  await build();
} else {
  console.error('usage: node sealed-decks.ts build --out out/sealed [--repo owner/name] [--prev-dir dir] [--force] [--publish] [--decklist f] [--decks-dir d --sets-dir d] [--min-decks n]');
  process.exit(2);
}
