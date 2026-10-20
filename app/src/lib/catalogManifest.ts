// What a catalog release says about itself, and how the app (or the release script) decides what to do with it.
// Pure; shared by the release script (tools/release.ts, runs in CI) and the app.

/** Highest catalog schema this version of the app can read. */
export const APP_CATALOG_SCHEMA = 4;

export interface ManifestFile {
  url: string;
  bytes: number;
  sha256: string;
}

export interface NewSet {
  code: string;
  name: string;
  /** printings of the set in this release */
  count: number;
  /** printings added since the previous release (equals count for a brand-new set) */
  added: number;
}

export interface CatalogManifest {
  format: 1;
  schema: number;
  /** ISO time the catalog was built; identifies this version */
  built_at: string;
  price_date: string;
  /** timestamp of the Scryfall bulk file the catalog was built from */
  source_updated_at: string;
  /** id of the full database that `delta` builds on; delta updates only apply to a catalog with the same base */
  base: string;
  base_tag: string;
  counts: { printings: number; illustrations: number; variants: number };
  /** set code -> printings */
  sets: Record<string, number>;
  /** set code -> display name */
  set_names: Record<string, string>;
  /** sets that appeared or grew since the previous release (for the release notes) */
  new_sets: NewSet[];
  full: ManifestFile;
  /** everything added or changed since the base (new cards, new art, price changes); null when this release is itself a base */
  delta: (ManifestFile & { from_base: string }) | null;
}

/** What the installed catalog reports about itself (cards.db `meta` table). */
export interface InstalledCatalog {
  built_at: string;
  base: string;
  schema: number;
}

export type UpdateDecision =
  | { kind: 'none' }
  | { kind: 'delta'; bytes: number; file: ManifestFile }
  | { kind: 'full'; bytes: number; file: ManifestFile }
  | { kind: 'app-too-old'; needed: number };

/** Delta updates are only worth it below this size; beyond it a fresh full download is just as reasonable and simpler. */
export const MAX_DELTA_BYTES = 30 * 1024 * 1024;

export function decideUpdate(installed: InstalledCatalog | null, manifest: CatalogManifest, appSchema = APP_CATALOG_SCHEMA): UpdateDecision {
  if (manifest.schema > appSchema) return { kind: 'app-too-old', needed: manifest.schema };
  if (installed && installed.built_at === manifest.built_at) return { kind: 'none' };
  // Never go backwards: an installed catalog newer than the manifest (a release was withdrawn) is left alone.
  if (installed && installed.built_at > manifest.built_at) return { kind: 'none' };
  if (installed && manifest.delta && installed.schema === manifest.schema && installed.base === manifest.delta.from_base && manifest.delta.bytes <= MAX_DELTA_BYTES) {
    return { kind: 'delta', bytes: manifest.delta.bytes, file: manifest.delta };
  }
  return { kind: 'full', bytes: manifest.full.bytes, file: manifest.full };
}

export const megabytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/** One line for the user: what is new in this update. */
export function describeUpdate(manifest: CatalogManifest, installedSets: Record<string, number> | null = null): string {
  // relative to what the user has, not to the previous release (they may be several releases behind)
  const fresh = (installedSets ? diffSets(installedSets, manifest.sets, manifest.set_names) : manifest.new_sets).filter((s) => s.added > 0);
  if (fresh.length === 0) return `Prices and card data as of ${manifest.price_date}`;
  const names = fresh.slice(0, 3).map((s) => s.name);
  const more = fresh.length - names.length;
  const total = fresh.reduce((sum, s) => sum + s.added, 0);
  return `${total} new card${total === 1 ? '' : 's'}: ${names.join(', ')}${more > 0 ? ` and ${more} more set${more === 1 ? '' : 's'}` : ''}`;
}

export interface HealthInput {
  printings: number;
  illustrations: number;
  /** distinct illustration ids in `cards` that have no fingerprint in `art` */
  unhashed: number;
  schema: number;
  integrityOk: boolean;
}

/**
 * Refuses to publish a catalog that looks broken (a failed download of the bulk data, a rate-limited image fetch, a changed Scryfall format).
 * The previous release then stays in place.
 */
export function checkHealth(prev: CatalogManifest | null, next: HealthInput): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!next.integrityOk) problems.push('SQLite integrity check failed');
  if (next.schema !== APP_CATALOG_SCHEMA) problems.push(`schema ${next.schema} is not the one this app reads (${APP_CATALOG_SCHEMA})`);
  if (next.printings < 50000) problems.push(`only ${next.printings} printings`);
  if (next.illustrations < 30000) problems.push(`only ${next.illustrations} illustrations`);
  if (next.unhashed > 0.005 * Math.max(1, next.illustrations + next.unhashed)) problems.push(`${next.unhashed} illustrations have no fingerprint (more than 0.5 %)`);
  if (prev) {
    if (next.printings < 0.98 * prev.counts.printings) problems.push(`printings fell from ${prev.counts.printings} to ${next.printings}`);
    if (next.illustrations < 0.98 * prev.counts.illustrations) problems.push(`illustrations fell from ${prev.counts.illustrations} to ${next.illustrations}`);
  }
  return { ok: problems.length === 0, problems };
}

/** A new full database becomes the base when there is none, the schema changed, the base is old, or the delta stopped being small. */
export function needsNewBase(prev: CatalogManifest | null, now: Date, deltaBytes: number | null, fullBytes: number): boolean {
  if (!prev) return true;
  if (prev.schema !== APP_CATALOG_SCHEMA) return true;
  const baseTime = Date.parse(prev.base);
  if (!Number.isNaN(baseTime) && now.getTime() - baseTime > 21 * 24 * 3600 * 1000) return true;
  if (deltaBytes == null) return true;
  return deltaBytes > Math.min(MAX_DELTA_BYTES, 0.4 * fullBytes);
}

/** Sets that are new or grew since the previous release. `names` maps set code to display name. */
export function diffSets(prev: Record<string, number> | null, next: Record<string, number>, names: Record<string, string>): NewSet[] {
  const out: NewSet[] = [];
  for (const [code, count] of Object.entries(next)) {
    const before = prev?.[code] ?? 0;
    if (count > before) out.push({ code, name: names[code] ?? code.toUpperCase(), count, added: count - before });
  }
  // brand-new sets first, then by how many cards arrived
  return out.sort((a, b) => Number((b.count === b.added) as boolean) - Number((a.count === a.added) as boolean) || b.added - a.added);
}
