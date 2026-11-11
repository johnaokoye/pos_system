// Database backups (Settings → Backups, routes/backups.js), on a schedule
// (server.js calls tick() every minute) or on demand.
//
// Each backup is one complete copy of the database made with VACUUM INTO — a
// consistent snapshot taken while the app runs, written to `backups/` next to
// the database file (on the Portainer server that's the stack's data folder,
// so backups survive redeploys). Only works when the database is a local file;
// on Turso (Vercel) Turso keeps its own backups.
//
// The driver is synchronous, so while VACUUM INTO runs every other request
// waits — schedule it for when the store is closed.
//
// Optional off-server copy: each backup is also copied into backup_copy_dir,
// any folder mounted into the container (e.g. an SMB share mounted by Docker
// or the host — see the manual). Copied as .partial then renamed, so a half
// copy never looks like a backup. Each place keeps its own number of copies;
// only files named like ours (pos-YYYYMMDD-HHMMSS.db) are ever deleted.
//
// Settings (settings table): backup_enabled 0|1, backup_frequency
// daily|hours, backup_time HH:MM (store clock), backup_every_hours,
// backup_keep, backup_copy_dir, backup_copy_keep; backup_last_scheduled_at
// (UTC ISO) is when the schedule last ran. Every run is a `backups` row.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { db } = require('../database');
const { refreshStoreTz } = require('./storeTime');
const { storeParts, backupDue } = require('./backupSchedule');

const FILE_RE = /^pos-\d{8}-\d{6}\.db$/;
const DEFAULTS = {
  backup_enabled: '0', backup_frequency: 'daily', backup_time: '02:00', backup_every_hours: '6',
  backup_keep: '14', backup_copy_dir: '', backup_copy_keep: '30',
};
let running = false;

function dbFilePath() {
  const url = process.env.TURSO_DATABASE_URL || 'file:pos.db';
  return url.startsWith('file:') ? path.resolve(url.slice(5)) : null;
}
function backupDir() {
  const f = dbFilePath();
  return f ? path.join(path.dirname(f), 'backups') : null;
}
function available() {
  return dbFilePath() ? { ok: true } : { ok: false, reason: 'The database is on Turso, which keeps its own backups — there is no local database file to back up here.' };
}

async function getSettings() {
  const keys = [...Object.keys(DEFAULTS), 'backup_last_scheduled_at'];
  const { rows } = await db.execute({ sql: `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, args: keys });
  const out = { ...DEFAULTS, backup_last_scheduled_at: null };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function setSetting(key, value) {
  await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, value == null ? null : String(value)] });
}

// Where a copy can go: an absolute folder that exists and isn't the backups
// folder itself. Returns an error message or null.
async function copyDirProblem(dir) {
  if (!dir) return null;
  if (!path.isAbsolute(dir)) return 'The copy folder must be a full path inside the app container, e.g. /app/backups-offsite';
  const own = backupDir();
  if (own && path.resolve(dir) === path.resolve(own)) return 'The copy folder has to be somewhere other than the backups folder itself';
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return `${dir} is not a folder`;
  } catch (e) {
    return `${dir} doesn't exist in the app container — is the share mounted into it?`;
  }
  return null;
}

// Writes and removes a small file to prove the copy folder is writable.
async function testCopyDir(dir) {
  const problem = await copyDirProblem(dir);
  if (problem) return { ok: false, error: problem };
  const probe = path.join(dir, `.pos-backup-test-${Date.now()}`);
  try {
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Can't write to ${dir}: ${e.message}` };
  }
}

// Keeps the newest `keep` of our backup files in `dir`; returns the deleted names.
async function prune(dir, keep) {
  const n = Math.max(1, parseInt(keep, 10) || 1);
  let names;
  try { names = (await fsp.readdir(dir)).filter(f => FILE_RE.test(f)).sort().reverse(); } catch (e) { return []; }
  const gone = [];
  for (const f of names.slice(n)) {
    try { await fsp.unlink(path.join(dir, f)); gone.push(f); } catch (e) { /* left for next time */ }
  }
  return gone;
}

// Makes one backup. kind 'scheduled' | 'manual'. Returns the backups row.
async function runBackup({ kind = 'manual', employeeId = null } = {}) {
  const avail = available();
  if (!avail.ok) throw new Error(avail.reason);
  if (running) throw new Error('A backup is already running — try again in a moment');
  const settings = await getSettings();
  running = true;
  const started = Date.now();
  const dir = backupDir();
  let filename = null, size = null, status = 'ok', error = null;
  let copyStatus = null, copyError = null, copiedPath = null;
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Names go to the second: one made in the same second as another (e.g.
    // the safety backup a restore takes) waits for the next second.
    const tz = await refreshStoreTz();
    let target;
    for (let attempt = 0; ; attempt++) {
      const { day, time } = storeParts(new Date(), tz);
      filename = `pos-${day.replace(/-/g, '')}-${time.replace(/:/g, '')}.db`;
      target = path.join(dir, filename);
      if (!fs.existsSync(target)) break;
      if (attempt >= 3) throw new Error(`${filename} already exists — try again in a moment`);
      await new Promise(r => setTimeout(r, 1000));
    }
    await db.execute({ sql: `VACUUM INTO '${target.replace(/'/g, "''")}'`, args: [] });
    size = (await fsp.stat(target)).size;

    const copyDir = String(settings.backup_copy_dir || '').trim();
    if (copyDir) {
      const problem = await copyDirProblem(copyDir);
      if (problem) { copyStatus = 'failed'; copyError = problem; }
      else {
        try {
          const dest = path.join(copyDir, filename);
          await fsp.copyFile(target, `${dest}.partial`);
          await fsp.rename(`${dest}.partial`, dest);
          copyStatus = 'ok'; copiedPath = dest;
          await prune(copyDir, settings.backup_copy_keep);
        } catch (e) {
          copyStatus = 'failed'; copyError = e.message;
          try { await fsp.unlink(path.join(copyDir, `${filename}.partial`)); } catch (_) { /* nothing to tidy */ }
        }
      }
      if (copyStatus === 'failed') console.error(`[backup] ${filename} saved, but copying it to ${copyDir} failed: ${copyError}`);
    }
    const gone = await prune(dir, settings.backup_keep);
    if (gone.length) await db.execute({ sql: `UPDATE backups SET deleted_at = CURRENT_TIMESTAMP WHERE filename IN (${gone.map(() => '?').join(',')}) AND deleted_at IS NULL`, args: gone });
  } catch (e) {
    status = 'failed'; error = e.message;
    console.error(`[backup] ${kind} backup failed: ${e.message}`);
  } finally {
    running = false;
  }
  const r = await db.execute({
    sql: `INSERT INTO backups (filename, size_bytes, kind, status, error, copy_status, copy_error, copied_path, employee_id, duration_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [status === 'ok' ? filename : null, size, kind, status, error, copyStatus, copyError, copiedPath, employeeId, Date.now() - started],
  });
  const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM backups WHERE id = ?', args: [Number(r.lastInsertRowid)] });
  if (status === 'ok') console.log(`[backup] ${kind} backup ${filename} (${Math.round(size / 1024 / 1024 * 10) / 10} MB) in ${row.duration_ms} ms${copyStatus === 'ok' ? ` — copied to ${copiedPath}` : ''}`);
  return row;
}

// Whether the schedule is due now (lib/backupSchedule.js).
async function isDue(settings, now = new Date()) {
  return backupDue(settings, now, settings.backup_frequency === 'hours' ? 'UTC' : await refreshStoreTz());
}

// Called every minute by server.js.
async function tick() {
  if (running || !available().ok) return;
  const settings = await getSettings();
  if (!(await isDue(settings))) return;
  // Mark the slot taken first, so a failure doesn't retry every minute.
  await setSetting('backup_last_scheduled_at', new Date().toISOString());
  await runBackup({ kind: 'scheduled' });
}

// For the Settings screen: settings, recent runs and whether the schedule is
// behind (no good scheduled backup in its interval plus an hour).
// Backup files in a folder: name -> size.
async function filesIn(dir) {
  const out = new Map();
  if (!dir) return out;
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(f => FILE_RE.test(f)); } catch (e) { return out; }
  for (const f of names) { try { out.set(f, (await fsp.stat(path.join(dir, f))).size); } catch (e) { /* gone meanwhile */ } }
  return out;
}

// For the Settings screen: settings, the backups — each logged run, plus any
// backup file on the server or in the copy folder the database has no row for
// (e.g. newer ones after a restore to an older backup) — whether the schedule
// is behind (no good scheduled backup in its interval plus an hour), and the
// last restore.
async function status() {
  const settings = await getSettings();
  const { rows: backups } = await db.execute({
    sql: `SELECT b.*, e.first_name || ' ' || e.last_name AS employee_name FROM backups b LEFT JOIN employees e ON e.id = b.employee_id
          WHERE b.deleted_at IS NULL ORDER BY b.id DESC LIMIT 100`, args: [] });
  const dir = backupDir();
  const copyDir = String(settings.backup_copy_dir || '').trim();
  const local = await filesIn(dir);
  const copied = copyDir && !(await copyDirProblem(copyDir)) ? await filesIn(copyDir) : new Map();
  for (const b of backups) { b.exists = !!(b.filename && local.has(b.filename)); b.in_copy = !!(b.filename && copied.has(b.filename)); }
  const known = new Set(backups.map(b => b.filename).filter(Boolean));
  for (const f of new Set([...local.keys(), ...copied.keys()])) {
    if (known.has(f)) continue;
    const m = /^pos-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.db$/.exec(f);
    backups.push({ id: null, filename: f, kind: 'found', status: 'ok', size_bytes: local.get(f) ?? copied.get(f),
      store_time: m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null, exists: local.has(f), in_copy: copied.has(f) });
  }
  // Newest first by file name (the store-clock time), failed runs by id.
  backups.sort((a, b) => (b.filename || '').localeCompare(a.filename || '') || (b.id || 0) - (a.id || 0));
  const { rows: [lastOk] } = await db.execute({ sql: "SELECT created_at FROM backups WHERE status = 'ok' AND kind = 'scheduled' ORDER BY id DESC LIMIT 1", args: [] });
  const intervalMs = settings.backup_frequency === 'hours' ? Math.max(1, parseInt(settings.backup_every_hours, 10) || 6) * 3600000 : 24 * 3600000;
  const lastOkAt = lastOk ? new Date(String(lastOk.created_at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(lastOk.created_at) ? '' : 'Z')) : null;
  const behind = settings.backup_enabled === '1' && settings.backup_last_scheduled_at
    && (!lastOkAt || Date.now() - lastOkAt.getTime() > intervalMs + 3600000);
  const avail = available();
  return { available: avail.ok, unavailable_reason: avail.reason || null, dir, settings, backups, running, behind: !!behind,
    last_restore: require('./restore').lastRestore() };
}

// Path of a backup file by name, on the server (where 'local') or in the copy
// folder ('copy'); null if the name isn't one of ours or it isn't there.
async function backupFile(filename, where = 'local') {
  if (!FILE_RE.test(String(filename || ''))) return null;
  const dir = where === 'copy' ? String((await getSettings()).backup_copy_dir || '').trim() : backupDir();
  if (!dir) return null;
  const f = path.join(dir, filename);
  return fs.existsSync(f) ? f : null;
}

module.exports = { runBackup, tick, status, getSettings, setSetting, testCopyDir, copyDirProblem, backupFile, backupDir, isDue, DEFAULTS, FILE_RE };
