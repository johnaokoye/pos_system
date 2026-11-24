// Rental reminder emails to customers (owner's request, 2026-11-24): the day
// before a rental is due back, on the due day, and once it's overdue (then
// every OVERDUE_EVERY_DAYS days, at most OVERDUE_MAX times). Each email links
// to the rental's tracking page on the website (Settings → Website → Website
// URL, /account/rentals/:id).
//
// Off until Settings → Website → "Email rental reminders" is ticked
// (`rental_reminders_enabled` = '1'); ticking it stamps
// `rental_reminders_since` (store day), and only rentals due on or after that
// day are reminded — so turning it on never mails every old overdue rental.
// Only active, unpaused rentals of active customers with an email; sent from
// REMINDER_HOUR on the store clock. Every attempt is logged in
// rental_reminder_emails; a kind is sent once per due date (overdue: see
// above), and a failed send is retried after RETRY_HOURS.
const { storeToday, storeTz } = require('./storeTime');

const REMINDER_HOUR = 8;
const OVERDUE_EVERY_DAYS = 3;
const OVERDUE_MAX = 3;
const RETRY_HOURS = 6;

const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const storeHour = now => Number(new Intl.DateTimeFormat('en-US', { timeZone: storeTz(), hour: 'numeric', hourCycle: 'h23' }).format(now));

// Which reminder (if any) is due for this rental today: 'due_soon' | 'due_today' | 'overdue'.
function reminderKind(dueDate, today) {
  const d = String(dueDate).slice(0, 10);
  if (today === addDays(d, -1)) return 'due_soon';
  if (today === d) return 'due_today';
  if (today > d) return 'overdue';
  return null;
}

async function remindersFor(db, agreementId) {
  return (await db.execute({ sql: 'SELECT * FROM rental_reminder_emails WHERE agreement_id = ? ORDER BY id', args: [agreementId] })).rows;
}

// Should `kind` go out now, given what's been sent for this due date?
function shouldSend(kind, dueDate, today, log, now) {
  const forDue = log.filter(r => r.kind === kind && r.due_date === dueDate);
  const sent = forDue.filter(r => r.status === 'sent');
  const lastFail = forDue.filter(r => r.status === 'failed').pop();
  if (lastFail && now - Date.parse(String(lastFail.created_at).replace(' ', 'T') + (String(lastFail.created_at).includes('Z') ? '' : 'Z')) < RETRY_HOURS * 3600000) return false;
  if (kind !== 'overdue') return sent.length === 0;
  if (sent.length >= OVERDUE_MAX) return false;
  if (!sent.length) return true;
  return daysBetween(String(sent[sent.length - 1].sent_day), today) >= OVERDUE_EVERY_DAYS;
}

// One pass. `force` skips the enabled/hour checks (POST /rentals/reminders/run).
// `send` is injectable for tests; default = routes/email.js sendRentalReminderEmail.
async function runRentalReminders(db, { now = new Date(), force = false, send } = {}) {
  const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('rental_reminders_enabled', 'rental_reminders_since')", args: [] });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!force && s.rental_reminders_enabled !== '1') return { skipped: 'disabled', sent: [], failed: [] };
  if (!force && storeHour(now) < REMINDER_HOUR) return { skipped: 'too_early', sent: [], failed: [] };
  const today = storeToday();
  const since = s.rental_reminders_since || today;
  const sendEmail = send || require('../routes/email').sendRentalReminderEmail;

  const { rows: agreements } = await db.execute({
    sql: `SELECT ra.*, c.first_name, c.last_name, c.email AS customer_email, b.name AS branch_name, b.phone AS branch_phone, b.address AS branch_address
          FROM rental_agreements ra JOIN customers c ON c.id = ra.customer_id LEFT JOIN branches b ON b.id = ra.branch_id
          WHERE ra.status = 'active' AND COALESCE(ra.is_paused, 0) = 0 AND COALESCE(c.active, 1) = 1
            AND c.email IS NOT NULL AND TRIM(c.email) <> '' AND date(ra.due_date) >= date(?) AND date(ra.due_date) <= date(?, '+1 day')`,
    args: [since, today],
  });
  const sent = [], failed = [];
  for (const a of agreements) {
    const dueDate = String(a.due_date).slice(0, 10);
    const kind = reminderKind(dueDate, today);
    if (!kind) continue;
    const log = await remindersFor(db, a.id);
    if (!shouldSend(kind, dueDate, today, log, now.getTime())) continue;
    const { rows: items } = await db.execute({ sql: 'SELECT product_name, sku, quantity, quantity_returned, parent_item_id FROM rental_agreement_items WHERE agreement_id = ? ORDER BY COALESCE(parent_item_id, id), id', args: [a.id] });
    const out = items.filter(i => i.quantity > i.quantity_returned);
    if (!out.length) continue;
    const overdueNo = log.filter(r => r.kind === 'overdue' && r.due_date === dueDate && r.status === 'sent').length + 1;
    try {
      await sendEmail({ agreement: a, items: out, kind, daysOverdue: kind === 'overdue' ? daysBetween(dueDate, today) : 0, overdueNo });
      await db.execute({ sql: "INSERT INTO rental_reminder_emails (agreement_id, kind, due_date, sent_to, status, sent_day) VALUES (?, ?, ?, ?, 'sent', ?)", args: [a.id, kind, dueDate, a.customer_email, today] });
      sent.push({ agreement_id: a.id, agreement_number: a.agreement_number, kind, to: a.customer_email });
    } catch (e) {
      await db.execute({ sql: "INSERT INTO rental_reminder_emails (agreement_id, kind, due_date, sent_to, status, error, sent_day) VALUES (?, ?, ?, ?, 'failed', ?, ?)", args: [a.id, kind, dueDate, a.customer_email, String(e.message || e).slice(0, 500), today] });
      failed.push({ agreement_id: a.id, agreement_number: a.agreement_number, kind, error: e.message });
    }
  }
  return { today, sent, failed };
}

module.exports = { runRentalReminders, reminderKind, remindersFor, REMINDER_HOUR, OVERDUE_EVERY_DAYS, OVERDUE_MAX };
