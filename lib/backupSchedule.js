// When a scheduled backup is due (lib/backups.js) — kept free of the
// database so the rule can be tested on its own.

// "YYYY-MM-DD" and "HH:MM:SS" on the store clock.
function storeParts(date, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// settings: backup_enabled, backup_frequency daily|hours, backup_time HH:MM,
// backup_every_hours, backup_last_scheduled_at (UTC ISO). Daily: due once the
// store clock passes today's time, unless the schedule already ran since
// then. Every N hours: due N hours after the last run.
function backupDue(settings, now, tz) {
  if (settings.backup_enabled !== '1') return false;
  const last = settings.backup_last_scheduled_at ? new Date(settings.backup_last_scheduled_at) : null;
  if (settings.backup_frequency === 'hours') {
    const hours = Math.max(1, parseInt(settings.backup_every_hours, 10) || 6);
    return !last || now - last >= hours * 3600000 - 30000;
  }
  const nowP = storeParts(now, tz);
  const target = `${nowP.day} ${String(settings.backup_time || '02:00').slice(0, 5)}`;
  if (`${nowP.day} ${nowP.time.slice(0, 5)}` < target) return false;
  if (!last) return true;
  const lastP = storeParts(last, tz);
  return `${lastP.day} ${lastP.time.slice(0, 5)}` < target;
}

module.exports = { storeParts, backupDue };
