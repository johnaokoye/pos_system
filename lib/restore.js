// Restoring a database backup (Settings → Database Backups → Restore).
//
// The open database can't be swapped under the running app, so a restore is
// staged by POST /api/backups/restore (routes/backups.js): the chosen backup
// is copied to restore-staged.db beside the database, checked, a backup of
// the current data is taken, and restore-pending.json is written; then the
// app exits and Docker (restart: unless-stopped) starts it again. Here, at
// startup and before database.js opens the database, the current database
// and its -wal/-shm files are moved aside as pos-before-restore-<stamp>.db
// (kept, never deleted) and the staged file takes its place. _init() then
// brings an older backup's schema up to date as usual. The outcome is written
// to restore-last.json for the Backups card. On any error the original files
// are put back.
//
// Only for a local file database (not Turso).

const fs = require('fs');
const path = require('path');

function dbFile() {
  const url = process.env.TURSO_DATABASE_URL || 'file:pos.db';
  return url.startsWith('file:') ? path.resolve(url.slice(5)) : null;
}
const paths = f => {
  const dir = path.dirname(f);
  return {
    dir,
    staged: path.join(dir, 'restore-staged.db'),
    pending: path.join(dir, 'restore-pending.json'),
    last: path.join(dir, 'restore-last.json'),
  };
};

// Synchronous on purpose: runs before anything opens the database.
function applyPendingRestore() {
  const f = dbFile();
  if (!f) return;
  const p = paths(f);
  if (!fs.existsSync(p.pending)) return;
  let req = {};
  try { req = JSON.parse(fs.readFileSync(p.pending, 'utf8')); } catch (e) { /* recorded below */ }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const aside = path.join(p.dir, `pos-before-restore-${stamp}.db`);
  const result = { ...req, started_at: new Date().toISOString() };
  const moved = [];
  try {
    if (!fs.existsSync(p.staged)) throw new Error('The staged backup file is missing');
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + ext)) { fs.renameSync(f + ext, aside + ext); moved.push(ext); }
    }
    fs.renameSync(p.staged, f);
    result.status = 'ok';
    result.previous = path.basename(aside);
    console.log(`[restore] restored ${req.filename || 'backup'}; the previous database is kept as ${result.previous}`);
  } catch (e) {
    try { if (moved.includes('') && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* put back below */ }
    for (const ext of moved) { try { fs.renameSync(aside + ext, f + ext); } catch (_) { /* best effort */ } }
    result.status = 'failed';
    result.error = e.message;
    console.error(`[restore] restore of ${req.filename || 'backup'} failed, the current database was kept: ${e.message}`);
  }
  try { fs.writeFileSync(p.last, JSON.stringify(result, null, 2)); } catch (_) { /* card just won't show it */ }
  try { fs.unlinkSync(p.pending); } catch (_) { /* would retry next start — staged file is gone, so it fails safe */ }
  try { if (fs.existsSync(p.staged)) fs.unlinkSync(p.staged); } catch (_) { /* leftover */ }
}

function lastRestore() {
  const f = dbFile();
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(paths(f).last, 'utf8')); } catch (e) { return null; }
}

module.exports = { applyPendingRestore, lastRestore, restorePaths: () => { const f = dbFile(); return f ? paths(f) : null; } };
