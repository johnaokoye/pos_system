import { test, expect } from './fixtures.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import schedule from '../lib/backupSchedule.js';
import { execFileSync } from 'child_process';

// Settings → Database Backups (routes/backups.js, lib/backups.js).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);

test('back up now, copy to a folder, keep the last N, and download', async ({ page }) => {
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-backup-copy-'));
  try {
    const before = await api(page, 'GET', '/backups');
    expect(before.available).toBe(true);
    // A folder that isn't there is refused before saving.
    expect(await refused(page, 'PUT', '/backups/settings', { enabled: false, frequency: 'daily', time: '02:00', keep: 2, copy_dir: '/no/such/share', copy_keep: 1 })).toContain("doesn't exist");
    expect((await api(page, 'POST', '/backups/test-copy', { copy_dir: copyDir })).ok).toBe(true);
    await api(page, 'PUT', '/backups/settings', { enabled: false, frequency: 'daily', time: '02:00', keep: 2, copy_dir: copyDir, copy_keep: 1 });

    const made = [];
    for (let i = 0; i < 3; i++) {
      made.push(await api(page, 'POST', '/backups/run', {})); // same second: waits for the next
    }
    for (const b of made) expect(b).toMatchObject({ status: 'ok', kind: 'manual', copy_status: 'ok' });

    // Keep 2 on the server, 1 in the copy folder.
    const status = await api(page, 'GET', '/backups');
    const onDisk = fs.readdirSync(status.dir).filter(f => /^pos-\d{8}-\d{6}\.db$/.test(f));
    expect(onDisk.sort()).toEqual(made.slice(1).map(b => b.filename).sort());
    expect(fs.readdirSync(copyDir)).toEqual([made[2].filename]);
    expect(status.backups.find(b => b.id === made[0].id)).toBeUndefined();

    // The download is a real SQLite database.
    const head = await page.evaluate(f => fetch(`/api/backups/files/${f}/download`).then(r => r.arrayBuffer()).then(b => new TextDecoder().decode(new Uint8Array(b).slice(0, 15))), made[2].filename);
    expect(head).toBe('SQLite format 3');

    // A file on disk with no row (e.g. after restoring an older backup) is
    // still listed; so is one only in the copy folder.
    const orphan = 'pos-20200101-000000.db';
    fs.copyFileSync(path.join(status.dir, made[2].filename), path.join(copyDir, orphan));
    const listed = (await api(page, 'GET', '/backups')).backups.find(b => b.filename === orphan);
    expect(listed).toMatchObject({ id: null, kind: 'found', exists: false, in_copy: true, store_time: '2020-01-01 00:00' });

    // Restore refusals (a successful restore restarts the server, so it's
    // tested on its own below): RESTORE typed, the right password, a sound file.
    expect(await refused(page, 'POST', '/backups/restore', { filename: made[2].filename, password: '123456' })).toContain('Type RESTORE');
    expect(await refused(page, 'POST', '/backups/restore', { filename: made[2].filename, password: 'wrong', confirm: 'RESTORE' })).toContain('password is not right');
    const broken = 'pos-20200102-000000.db';
    fs.writeFileSync(path.join(status.dir, broken), 'not a database');
    expect(await refused(page, 'POST', '/backups/restore', { filename: broken, password: '123456', confirm: 'RESTORE' })).toContain("Couldn't restore");
    fs.unlinkSync(path.join(status.dir, broken));
    expect(fs.existsSync(path.join(path.dirname(status.dir), 'restore-pending.json'))).toBe(false);

    // The screen lists them.
    await page.evaluate(() => App.showSection('settings'));
    await expect(page.locator('#s-backups')).toContainText(made[2].filename);
    await api(page, 'PUT', '/backups/settings', { enabled: false, frequency: 'daily', time: '02:00', keep: 14, copy_dir: '', copy_keep: 30 });
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
});

test('only settings_backups (or full Settings) can reach backups', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const group = await api(page, 'POST', '/security-groups', { name: `Tax only ${stamp}`, description: '', permissions: { settings: false, settings_tax: true } });
  const username = `bk${stamp}`;
  await api(page, 'POST', '/employees', { first_name: 'Tax', last_name: 'Only', username, pin: stamp.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await page.waitForLoadState('networkidle');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', 'pw-123456');
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
  expect(await refused(page, 'GET', '/backups')).toContain('settings_backups');
  expect(await refused(page, 'POST', '/backups/run', {})).toContain('settings_backups');
});

test('schedule: daily at the store-clock time once a day; every N hours', () => {
  const { backupDue } = schedule;
  const tz = 'America/Jamaica'; // UTC-5, no DST
  const daily = { backup_enabled: '1', backup_frequency: 'daily', backup_time: '02:00' };
  const at = s => new Date(s);
  expect(backupDue({ ...daily, backup_enabled: '0' }, at('2026-11-10T08:00:00Z'), tz)).toBe(false);
  // 01:59 store time: not yet; 02:00: due; already ran at 02:00: not again until tomorrow.
  expect(backupDue({ ...daily, backup_last_scheduled_at: '2026-11-09T07:00:30Z' }, at('2026-11-10T06:59:00Z'), tz)).toBe(false);
  expect(backupDue({ ...daily, backup_last_scheduled_at: '2026-11-09T07:00:30Z' }, at('2026-11-10T07:00:00Z'), tz)).toBe(true);
  expect(backupDue({ ...daily, backup_last_scheduled_at: '2026-11-10T07:00:30Z' }, at('2026-11-10T15:00:00Z'), tz)).toBe(false);
  // Server down at 2am: catches up when it comes back that day.
  expect(backupDue({ ...daily, backup_last_scheduled_at: '2026-11-09T07:00:30Z' }, at('2026-11-10T13:00:00Z'), tz)).toBe(true);
  const hourly = { backup_enabled: '1', backup_frequency: 'hours', backup_every_hours: '6', backup_last_scheduled_at: '2026-11-10T00:00:00Z' };
  expect(backupDue(hourly, at('2026-11-10T05:00:00Z'), tz)).toBe(false);
  expect(backupDue(hourly, at('2026-11-10T06:00:00Z'), tz)).toBe(true);
});

test('a staged restore swaps the database in at startup and keeps the old one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-restore-'));
  try {
    const db = path.join(dir, 'pos.db');
    fs.writeFileSync(db, 'CURRENT');
    fs.writeFileSync(`${db}-wal`, 'CURRENT-WAL');
    fs.writeFileSync(path.join(dir, 'restore-staged.db'), 'BACKUP');
    fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ filename: 'pos-20261111-020000.db', requested_by_name: 'Test' }));
    const run = () => execFileSync(process.execPath, ['-e', "require('./lib/restore').applyPendingRestore()"], { env: { ...process.env, TURSO_DATABASE_URL: `file:${db}` }, cwd: process.cwd() });
    run();
    expect(fs.readFileSync(db, 'utf8')).toBe('BACKUP');
    expect(fs.existsSync(`${db}-wal`)).toBe(false); // the old WAL must never meet the restored file
    const aside = fs.readdirSync(dir).filter(f => /^pos-before-restore-.*\.db$/.test(f));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('CURRENT');
    expect(fs.readFileSync(path.join(dir, `${aside[0]}-wal`), 'utf8')).toBe('CURRENT-WAL');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'restore-last.json'), 'utf8'))).toMatchObject({ status: 'ok', filename: 'pos-20261111-020000.db', previous: aside[0] });
    expect(fs.existsSync(path.join(dir, 'restore-pending.json'))).toBe(false);

    // Staged file missing: nothing changes, and it says why.
    fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ filename: 'pos-x.db' }));
    run();
    expect(fs.readFileSync(db, 'utf8')).toBe('BACKUP');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'restore-last.json'), 'utf8'))).toMatchObject({ status: 'failed' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
