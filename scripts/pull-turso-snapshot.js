// Pulls a full snapshot of the Turso database (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
// from .env) into a local SQLite file, ready to copy onto a Docker deployment's
// ./data/pos.db path when promoting a dev/staging database to production.
//
// Usage:
//   node scripts/pull-turso-snapshot.js [output-path]
//   npm run pull-turso-snapshot -- [output-path]
//
// Defaults to writing pos-turso-snapshot.db in the repo root (gitignored).
// Builds the destination schema via database.js's own ensureReady() — the
// exact same migration/init logic a real deploy runs — so it's guaranteed
// to match production schema, then copies every table's rows over from
// Turso in dependency-safe order (sqlite_master preserves creation order),
// preserving row IDs so foreign-key relationships stay intact.
//
// Does not touch any existing local pos.db or any running deployment —
// it only ever writes to the output path given (or the default above).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const { createClient } = require('@libsql/client');

const DEST_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'pos-turso-snapshot.db');

async function main() {
  const sourceUrl = process.env.TURSO_DATABASE_URL;
  const sourceToken = process.env.TURSO_AUTH_TOKEN;
  if (!sourceUrl || !sourceUrl.startsWith('libsql:')) {
    throw new Error('TURSO_DATABASE_URL must be set to a real libsql:// URL in .env to pull from Turso');
  }

  const source = createClient({ url: sourceUrl, authToken: sourceToken });

  // Point database.js's own connection at the fresh destination file, then
  // run its real init logic (creates every table + runs every migration +
  // seeds baseline demo data) — guarantees schema parity with production.
  process.env.TURSO_DATABASE_URL = `file:${DEST_PATH}`;
  delete process.env.TURSO_AUTH_TOKEN;
  const { db: dest, ensureReady } = require('../database');
  await ensureReady();

  // Wipe the seeded demo data (schema stays) — sqlite_master preserves
  // creation order, which is dependency-safe (parents created before the
  // children that reference them), so deleting in reverse order is FK-safe.
  const { rows: tables } = await dest.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    args: [],
  });
  const tableNames = tables.map(t => t.name);
  await dest.execute({ sql: 'PRAGMA foreign_keys = OFF', args: [] });
  for (const name of [...tableNames].reverse()) {
    await dest.execute({ sql: `DELETE FROM ${name}`, args: [] });
  }

  // Copy every table's rows from Turso, in the same dependency-safe order.
  console.log('Copying tables from Turso ->', DEST_PATH);
  let totalRows = 0;
  for (const name of tableNames) {
    const { rows: srcRows, columns } = await source.execute({ sql: `SELECT * FROM ${name}`, args: [] });
    if (!srcRows.length) { console.log(`  ${name}: 0 rows`); continue; }
    const cols = columns;
    const placeholders = cols.map(() => '?').join(',');
    const insertSql = `INSERT INTO ${name} (${cols.join(',')}) VALUES (${placeholders})`;
    for (const row of srcRows) {
      const args = cols.map(c => row[c]);
      await dest.execute({ sql: insertSql, args });
    }
    console.log(`  ${name}: ${srcRows.length} rows`);
    totalRows += srcRows.length;
  }
  await dest.execute({ sql: 'PRAGMA foreign_keys = ON', args: [] });

  console.log(`\nDone. ${totalRows} total rows copied into ${DEST_PATH}`);
  console.log('Copy this file onto the server as ./data/pos.db (stop the app container first), then redeploy.');
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
