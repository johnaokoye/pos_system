// Database backups — Settings → Backups (lib/backups.js). Everything here
// needs settings_backups: a backup holds every customer record and password
// hash, so seeing, making or downloading one is its own permission (a sub-key
// of Settings; a full Settings grant includes it).
const express = require('express');
const router = express.Router();
const fs = require('fs');
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const backups = require('../lib/backups');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

// Never through an API key (requirePermission lets those through by scope).
router.use((req, res, next) => req.apiKey ? res.status(403).json({ error: 'Backups are not available to API keys' }) : next());
router.use(requirePermission('settings_backups'));

router.get('/', async (req, res) => {
  try { res.json(await backups.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Schedule and copy-folder settings.
router.put('/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const enabled = b.enabled ? '1' : '0';
    const frequency = b.frequency === 'hours' ? 'hours' : 'daily';
    const time = String(b.time || '02:00');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Enter the backup time as HH:MM, e.g. 02:00' });
    const every = parseInt(b.every_hours, 10);
    if (frequency === 'hours' && !(every >= 1 && every <= 168)) return res.status(400).json({ error: 'Back up every 1 to 168 hours' });
    const keep = parseInt(b.keep, 10);
    if (!(keep >= 1 && keep <= 365)) return res.status(400).json({ error: 'Keep between 1 and 365 backups' });
    const copyDir = String(b.copy_dir || '').trim();
    const copyKeep = parseInt(b.copy_keep, 10);
    if (copyDir) {
      const problem = await backups.copyDirProblem(copyDir);
      if (problem) return res.status(400).json({ error: problem });
      if (!(copyKeep >= 1 && copyKeep <= 3650)) return res.status(400).json({ error: 'Keep between 1 and 3650 copies in the copy folder' });
    }
    const values = {
      backup_enabled: enabled, backup_frequency: frequency, backup_time: time,
      backup_every_hours: String(frequency === 'hours' ? every : (parseInt(b.every_hours, 10) || 6)),
      backup_keep: String(keep), backup_copy_dir: copyDir, backup_copy_keep: String(copyKeep >= 1 ? copyKeep : 30),
    };
    const before = await backups.getSettings();
    for (const [k, v] of Object.entries(values)) await backups.setSetting(k, v);
    // A changed schedule starts from now, so turning it on (or moving to every
    // N hours) doesn't fire a backup straight away mid-day.
    if (enabled === '1' && (before.backup_enabled !== '1' || before.backup_frequency !== frequency || before.backup_time !== time)) {
      await backups.setSetting('backup_last_scheduled_at', new Date().toISOString());
    }
    res.json(await backups.status());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Back up now.
router.post('/run', async (req, res) => {
  try {
    const row = await backups.runBackup({ kind: 'manual', employeeId: req.employee?.id || null });
    if (row.status !== 'ok') return res.status(500).json({ error: `Backup failed: ${row.error}`, backup: row });
    res.status(201).json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Proves the copy folder is there and writable, before saving it.
router.post('/test-copy', async (req, res) => {
  try { res.json(await backups.testCopyDir(String(req.body?.copy_dir || '').trim())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Download / delete by file name — also files the database has no row for
// (after a restore, or only in the copy folder). ?from=copy reads the copy
// folder; delete only ever removes the copy on the server.
router.get('/files/:filename/download', async (req, res) => {
  try {
    const file = await backups.backupFile(req.params.filename, req.query.from === 'copy' ? 'copy' : 'local');
    if (!file) return res.status(404).json({ error: 'That backup file is no longer there' });
    console.log(`[backup] ${req.params.filename} downloaded by employee ${req.employee?.id || '?'}`);
    res.download(file, req.params.filename);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/files/:filename', async (req, res) => {
  try {
    const file = await backups.backupFile(req.params.filename, 'local');
    if (!file) return res.status(404).json({ error: 'That backup file is no longer on the server' });
    await fs.promises.unlink(file);
    await db.execute({ sql: 'UPDATE backups SET deleted_at = CURRENT_TIMESTAMP WHERE filename = ? AND deleted_at IS NULL', args: [req.params.filename] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restore: puts the database back as it was in a backup (lib/restore.js).
// Needs the person's own password and `confirm: 'RESTORE'`. The backup is
// copied to restore-staged.db and checked (opens, quick_check ok, has the
// POS's tables), a backup of the data as it is now is taken (kind
// 'pre_restore', so this can be undone from the same list), then the restore
// is left pending and the app exits; Docker starts it again and the swap
// happens before the database is opened. Everyone is signed out.
let restoring = false;
router.post('/restore', async (req, res) => {
  const paths = require('../lib/restore').restorePaths();
  if (!paths) return res.status(400).json({ error: 'Restore is only for a local database file' });
  if (restoring || fs.existsSync(paths.pending)) return res.status(409).json({ error: 'A restore is already under way' });
  restoring = true;
  let staged = false;
  try {
    const { filename, from, password, confirm } = req.body || {};
    if (confirm !== 'RESTORE') { restoring = false; return res.status(400).json({ error: 'Type RESTORE to confirm' }); }
    const { rows: [me] } = await db.execute({ sql: 'SELECT id, first_name, last_name, password FROM employees WHERE id = ? AND active = 1', args: [req.employee?.id || 0] });
    const stored = me?.password;
    const ok = !!stored && !!password && (/^\$2[aby]\$/.test(stored) ? await bcrypt.compare(String(password), stored) : String(password) === stored);
    if (!ok) { restoring = false; return res.status(403).json({ error: 'That password is not right', code: 'bad_password' }); }
    const source = await backups.backupFile(filename, from === 'copy' ? 'copy' : 'local');
    if (!source) { restoring = false; return res.status(404).json({ error: 'That backup file is no longer there' }); }

    // Stage a copy first, so pruning by the backup below can't remove the
    // source, then check the copy is a sound POS database.
    await fs.promises.copyFile(source, `${paths.staged}.partial`);
    await fs.promises.rename(`${paths.staged}.partial`, paths.staged);
    staged = true;
    const check = createClient({ url: `file:${paths.staged}` });
    try {
      const { rows: [qc] } = await check.execute('PRAGMA quick_check');
      if (String(Object.values(qc)[0]) !== 'ok') throw new Error(`the backup file is damaged (${Object.values(qc)[0]})`);
      const { rows } = await check.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('employees', 'products', 'transactions')");
      if (rows.length < 3) throw new Error("it isn't a POS database");
    } finally { check.close(); }

    const before = await backups.runBackup({ kind: 'pre_restore', employeeId: me.id });
    if (before.status !== 'ok') throw new Error(`the backup of the current data failed (${before.error}), so nothing was restored`);

    fs.writeFileSync(paths.pending, JSON.stringify({
      filename, from: from === 'copy' ? 'copy' : 'local', requested_by: me.id, requested_by_name: `${me.first_name} ${me.last_name}`,
      requested_at: new Date().toISOString(), pre_restore_backup: before.filename,
    }, null, 2));
    console.log(`[restore] ${me.first_name} ${me.last_name} is restoring ${filename}; current data backed up as ${before.filename}; restarting`);
    const docker = fs.existsSync('/.dockerenv');
    res.json({ ok: true, pre_restore_backup: before.filename, restarts_itself: docker });
    // Let the reply go out, then exit: Docker starts the app again with the
    // restored database. Outside Docker it has to be started by hand.
    setTimeout(() => process.exit(0), 750);
  } catch (e) {
    restoring = false;
    if (staged) { try { fs.unlinkSync(paths.staged); } catch (_) { /* leftover */ } }
    res.status(400).json({ error: `Couldn't restore that backup: ${e.message}` });
  }
});

module.exports = router;
