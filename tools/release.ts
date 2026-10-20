// Release pipeline for the card catalog (runs in the data repo's workflow, see .github/workflows/update.yml).
//
//   node release.ts check   --repo owner/name [--force]
//       Decides whether a new catalog needs to be built: compares the Scryfall bulk file's timestamp with the one the latest release was built from.
//       Writes  skip=true|false  and  prev_base=...  to $GITHUB_OUTPUT.
//   node release.ts publish --repo owner/name --db out/cards.db [--dry-run] [--prev-manifest file] [--base-file file]
//       Health checks, delta against the base catalog, manifest, GitHub release, retention. Fails (and publishes nothing) when the catalog looks broken.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { APP_CATALOG_SCHEMA, checkHealth, diffSets, megabytes, needsNewBase, type CatalogManifest } from '../app/src/lib/catalogManifest.ts';
import { makeDelta } from './make-delta.ts';

const [command, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) args.set(key, '');
  else args.set(key, rest[++i]);
}
const REPO = args.get('repo') ?? process.env.GITHUB_REPOSITORY ?? '';
const DRY = args.has('dry-run');
const UA = { 'User-Agent': 'MTGScannerIndexBuilder/1.0' };

const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const output = (k: string, v: string) => {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};
const summary = (md: string) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  else console.log(md);
};

async function previousManifest(): Promise<CatalogManifest | null> {
  const local = args.get('prev-manifest');
  if (local) return existsSync(local) ? (JSON.parse(readFileSync(local, 'utf8')) as CatalogManifest) : null;
  const res = await fetch(`https://github.com/${REPO}/releases/latest/download/manifest.json`, { headers: UA });
  if (!res.ok) return null; // the very first release has none (404)
  try {
    return (await res.json()) as CatalogManifest;
  } catch {
    return null;
  }
}

async function check() {
  const prev = await previousManifest();
  const meta = (await (await fetch('https://api.scryfall.com/bulk-data/default_cards', { headers: UA })).json()) as { updated_at?: string };
  const same = !!prev && !!meta.updated_at && prev.source_updated_at === meta.updated_at;
  const skip = same && !args.has('force');
  output('skip', String(skip));
  output('source_updated_at', meta.updated_at ?? '');
  output('prev_base', prev?.base ?? '');
  summary(skip ? `No new Scryfall data since ${prev?.built_at}; nothing to do.` : `Building: Scryfall bulk data updated at ${meta.updated_at} (previous release: ${prev?.built_at ?? 'none'}).`);
}

function utcTag(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `db-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

async function publish() {
  const dbFile = path.resolve(args.get('db') ?? 'out/cards.db');
  const outDir = path.dirname(dbFile);
  const now = new Date();
  const prev = await previousManifest();
  const db = new DatabaseSync(dbFile);
  const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  // ---- health: do not publish a broken catalog
  const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  const health = checkHealth(prev, {
    printings: one('SELECT COUNT(*) AS n FROM cards'),
    illustrations: one('SELECT COUNT(*) AS n FROM art'),
    unhashed: Math.max(0, one("SELECT COUNT(DISTINCT illustration_id) AS n FROM cards WHERE illustration_id IS NOT NULL AND illustration_id NOT IN (SELECT illustration_id FROM art)") - Number(meta.placeholder_illustrations ?? 0)),
    schema: Number(meta.schema),
    integrityOk: integrity === 'ok',
  });
  if (!health.ok) {
    summary(`## Catalog rejected\n${health.problems.map((p) => `- ${p}`).join('\n')}\n\nThe previous release stays in place.`);
    throw new Error(`catalog failed health checks: ${health.problems.join('; ')}`);
  }

  // ---- sets
  const setRows = db.prepare('SELECT set_code, set_name, COUNT(*) AS n FROM cards GROUP BY set_code').all() as { set_code: string; set_name: string; n: number }[];
  const sets = Object.fromEntries(setRows.map((r) => [r.set_code, r.n]));
  const set_names = Object.fromEntries(setRows.map((r) => [r.set_code, r.set_name]));
  const new_sets = prev ? diffSets(prev.sets, sets, set_names) : [];

  // ---- base / delta
  const fullBytes = statSync(dbFile).size;
  let base = meta.built_at;
  let baseTag = '';
  let delta: CatalogManifest['delta'] = null;
  const deltaFile = path.join(outDir, 'delta.db');
  const tag = utcTag(now);
  let deltaBytes: number | null = null;
  if (prev) {
    const baseFile = args.get('base-file') ?? path.join(outDir, 'base.db');
    if (!args.get('base-file')) gh('release', 'download', prev.base_tag, '--repo', REPO, '--pattern', 'cards.db', '--output', baseFile, '--clobber');
    const baseMeta = new DatabaseSync(baseFile, { readOnly: true });
    const baseId = (baseMeta.prepare("SELECT value FROM meta WHERE key = 'base'").get() as { value: string } | undefined)?.value;
    baseMeta.close();
    if (baseId === prev.base) {
      // the catalog is "based on" the previous base: its meta must say so, because the app compares it with the delta's from_base
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('base', ?)").run(prev.base);
      const stats = makeDelta(baseFile, dbFile, deltaFile);
      deltaBytes = statSync(deltaFile).size;
      summary(`Delta against base ${prev.base_tag}: ${JSON.stringify(stats)} (${megabytes(deltaBytes)})`);
    } else {
      summary(`Base file of ${prev.base_tag} does not carry base id ${prev.base}; starting a new base.`);
    }
  }
  if (!needsNewBase(prev, now, deltaBytes, fullBytes) && prev) {
    base = prev.base;
    baseTag = prev.base_tag;
    delta = { url: `https://github.com/${REPO}/releases/download/${tag}/delta.db`, bytes: deltaBytes!, sha256: sha256(deltaFile), from_base: prev.base };
  } else {
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('base', ?)").run(meta.built_at);
    base = meta.built_at;
    baseTag = tag;
    delta = null;
  }
  db.close();

  const manifest: CatalogManifest = {
    format: 1,
    schema: Number(meta.schema),
    built_at: meta.built_at,
    price_date: meta.price_date,
    source_updated_at: meta.source_updated_at ?? '',
    base,
    base_tag: baseTag,
    counts: { printings: Number(meta.printings), illustrations: Number(meta.illustrations), variants: Number(meta.variants ?? 0) },
    sets,
    set_names,
    new_sets,
    full: { url: `https://github.com/${REPO}/releases/download/${tag}/cards.db`, bytes: statSync(dbFile).size, sha256: sha256(dbFile) },
    delta,
  };
  const manifestFile = path.join(outDir, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));

  const fresh = new_sets.filter((s) => s.added > 0);
  const notes = [
    `English paper printings with Scryfall prices as of ${meta.price_date}. Card data and images (c) Wizards of the Coast, via Scryfall.`,
    '',
    `${manifest.counts.printings} printings, ${manifest.counts.illustrations} illustrations, ${manifest.counts.variants} frame/border variants.`,
    delta ? `Delta update for apps on base ${base}: ${megabytes(delta.bytes)}.` : `This release is a new base for delta updates.`,
    fresh.length ? `\nNew or grown sets: ${fresh.slice(0, 12).map((s) => `${s.name} (+${s.added})`).join(', ')}.` : '',
  ].join('\n');
  summary(`## ${tag}\n${notes}`);

  if (DRY) {
    console.log(`dry run: would publish ${tag} with cards.db (${megabytes(manifest.full.bytes)}), manifest.json${delta ? `, delta.db (${megabytes(delta.bytes)})` : ''}`);
    return;
  }
  const assets = [dbFile, manifestFile, ...(delta ? [deltaFile] : [])];
  gh('release', 'create', tag, ...assets, '--repo', REPO, '--title', `Card database ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, '--notes', notes);

  // ---- retention: newest 7 releases, plus the base the current delta builds on
  const tags = (JSON.parse(gh('release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName')) as { tagName: string }[]).map((r) => r.tagName).filter((t) => t.startsWith('db-')).sort().reverse();
  const keep = new Set([...tags.slice(0, 7), baseTag]);
  for (const t of tags) if (!keep.has(t)) gh('release', 'delete', t, '--repo', REPO, '--yes', '--cleanup-tag');
}

mkdirSync('out', { recursive: true });
if (command === 'check') await check();
else if (command === 'publish') await publish();
else throw new Error('usage: node release.ts check|publish ...');
void copyFileSync;
void APP_CATALOG_SCHEMA;
