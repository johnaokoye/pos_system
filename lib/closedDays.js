// Closed-day return grace. At a branch with `closed_day_grace` on, a rental
// due back on a day the store is closed (every Sunday, plus the public
// holidays listed in Settings) may come back by the return-by time (default
// 8:00 AM) on the next open day without being charged for the extra time.
// Dates are store-local calendar dates; the return-by time is store-local
// wall-clock time in the `store_timezone` setting.

const DEFAULT_TIMEZONE = 'America/Jamaica';
const DEFAULT_RETURN_BY = '08:00';

// One holiday per line, "YYYY-MM-DD" optionally followed by a name.
function parseHolidays(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s*[-–—:]?\s*(.*)$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function closedReason(dateStr, holidays) {
  if (new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0) return 'Sunday';
  if (holidays.has(dateStr)) return holidays.get(dateStr) || 'Public holiday';
  return null;
}

// UTC instant of a store-local date + "HH:MM" in an IANA time zone.
function zonedTimeToUtc(dateStr, hhmm, timeZone) {
  const [h, mi] = String(hhmm).split(':').map(Number);
  const guess = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(mi || 0).padStart(2, '0')}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess).map(p => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess.getTime() - (asIfUtc - guess.getTime()));
}

async function loadClosedDaySettings(executor) {
  const { rows } = await executor.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('store_timezone','closed_day_return_by','public_holidays')", args: [] });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let timeZone = (s.store_timezone || '').trim() || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch (e) { timeZone = DEFAULT_TIMEZONE; }
  const returnBy = /^\d{1,2}:\d{2}$/.test(String(s.closed_day_return_by || '').trim()) ? s.closed_day_return_by.trim() : DEFAULT_RETURN_BY;
  return { timeZone, returnBy, holidays: parseHolidays(s.public_holidays) };
}

// For an agreement (needs due_date and `branch_closed_day_grace`), returns
// { closedReason, nextOpenDate, returnByAt } when its due date falls on a
// closed day at a branch that offers the grace — otherwise null.
function closedDayGrace(agreement, settings) {
  if (!agreement || !agreement.branch_closed_day_grace || !agreement.due_date) return null;
  const due = String(agreement.due_date).slice(0, 10);
  const reason = closedReason(due, settings.holidays);
  if (!reason) return null;
  let next = addDays(due, 1);
  for (let i = 0; i < 14 && closedReason(next, settings.holidays); i++) next = addDays(next, 1);
  return { closedReason: reason, nextOpenDate: next, returnBy: settings.returnBy, returnByAt: zonedTimeToUtc(next, settings.returnBy, settings.timeZone) };
}

module.exports = { parseHolidays, closedReason, zonedTimeToUtc, loadClosedDaySettings, closedDayGrace, DEFAULT_TIMEZONE, DEFAULT_RETURN_BY };
