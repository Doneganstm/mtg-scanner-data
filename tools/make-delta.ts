// Builds the delta database: everything in the new catalog that is not in (or differs from) the base catalog. The app attaches it to its installed
// catalog and merges it (app/src/lib/catalogDelta.ts).
//   node make-delta.ts <base.db> <new.db> <delta.db>
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DELTA_TABLES, buildDeltaSql } from '../app/src/lib/catalogDeltaBuild.ts';

export function makeDelta(baseFile: string, newFile: string, outFile: string): Record<string, number> {
  rmSync(outFile, { force: true });
  const db = new DatabaseSync(outFile);
  db.exec(buildDeltaSql(path.resolve(newFile), path.resolve(baseFile)));
  const stats: Record<string, number> = {};
  for (const t of DELTA_TABLES) stats[t] = (db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n;
  db.exec('VACUUM');
  db.close();
  return stats;
}

if (process.argv[1]?.endsWith('make-delta.ts')) {
  const [base, next, out] = process.argv.slice(2);
  if (!base || !next || !out) throw new Error('usage: node make-delta.ts <base.db> <new.db> <delta.db>');
  console.log(JSON.stringify(makeDelta(base, next, out)));
}
