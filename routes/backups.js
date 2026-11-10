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

async function backupRow(id) {
  const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM backups WHERE id = ? AND deleted_at IS NULL', args: [id] });
  const file = row && backups.backupFile(row.filename);
  return { row, file: file && fs.existsSync(file) ? file : null };
}

router.get('/:id/download', async (req, res) => {
  try {
    const { file, row } = await backupRow(req.params.id);
    if (!file) return res.status(404).json({ error: 'That backup file is no longer on the server' });
    console.log(`[backup] ${row.filename} downloaded by employee ${req.employee?.id || '?'}`);
    res.download(file, row.filename);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const { row, file } = await backupRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Backup not found' });
    if (file) await fs.promises.unlink(file);
    await db.execute({ sql: 'UPDATE backups SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', args: [row.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
