// Staff purchases — employees buying from the store for themselves.
//
// Each employee can have one staff account: a customer row with
// customers.staff_employee_id set (created or linked from the employee form).
// A sale to that account (POST /transactions):
//   • gets the staff discount (settings.staff_discount_pct, default 15%) as
//     the ticket discount — no other ticket or line discount on top;
//   • is cash only;
//   • can't be rung up by the employee themselves;
//   • can't take the employee past their purchase limit for the period
//     (settings.staff_purchase_period: 'month' | 'year', on the store clock).
// Limits: staff_purchase_limit_staff / _manager by the employee's tier
// (employees.staff_purchase_tier, set per person), or the employee's own
// employees.staff_purchase_limit when set.
//
// "Used" in a period = goods bought on the account (the sale's value after
// the staff discount, with GCT — store credit/cash back/an exchange's return
// credit count as paid) less returns processed in the period on the
// account's sales. So a return frees up the limit in the month it's made.

const { refreshStoreTz, storeToday, storeOffsetModifier } = require('./storeTime');

const DEFAULTS = { discount_pct: 15, limit_staff: 45000, limit_manager: 150000, period: 'month' };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function staffSettings(db) {
  const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('staff_discount_pct','staff_purchase_limit_staff','staff_purchase_limit_manager','staff_purchase_period')", args: [] });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    discount_pct: Math.min(100, num(s.staff_discount_pct, DEFAULTS.discount_pct)),
    limit_staff: num(s.staff_purchase_limit_staff, DEFAULTS.limit_staff),
    limit_manager: num(s.staff_purchase_limit_manager, DEFAULTS.limit_manager),
    period: s.staff_purchase_period === 'year' ? 'year' : 'month',
  };
}

// The period key for today (or a given YYYY-MM / YYYY), and its label.
function periodInfo(period, key) {
  const today = storeToday();
  const k = key || (period === 'year' ? today.slice(0, 4) : today.slice(0, 7));
  const label = period === 'year' ? k
    : new Date(`${k}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { key: k, label, fmt: period === 'year' ? '%Y' : '%Y-%m' };
}

function limitFor(emp, settings) {
  if (emp.staff_purchase_limit != null && emp.staff_purchase_limit !== '') return Number(emp.staff_purchase_limit);
  return emp.staff_purchase_tier === 'manager' ? settings.limit_manager : settings.limit_staff;
}

// The staff account's employee for a customer, or null when it isn't one.
async function staffAccountFor(db, customerId) {
  if (!customerId) return null;
  const { rows: [row] } = await db.execute({
    sql: `SELECT e.id AS employee_id, e.first_name, e.last_name, e.active, e.staff_purchase_tier, e.staff_purchase_limit
          FROM customers c JOIN employees e ON e.id = c.staff_employee_id WHERE c.id = ?`,
    args: [customerId],
  });
  return row || null;
}

// Purchases, returns and what's used on one account in a period.
async function usage(db, customerId, pi) {
  const off = storeOffsetModifier();
  const { rows: [p] } = await db.execute({
    sql: `SELECT COUNT(*) AS sales,
            COALESCE(SUM(total + COALESCE(store_credit_applied, 0) + COALESCE(cash_back_applied, 0)
              + CASE WHEN source_return_id IS NOT NULL THEN COALESCE(discount_amount, 0) ELSE 0 END), 0) AS purchases,
            COALESCE(SUM(CASE WHEN source_return_id IS NULL THEN COALESCE(discount_amount, 0) ELSE 0 END), 0) AS discount_given
          FROM transactions
          WHERE customer_id = ? AND status NOT IN ('hold', 'voided') AND strftime('${pi.fmt}', created_at, '${off}') = ?`,
    args: [customerId, pi.key],
  });
  const { rows: [r] } = await db.execute({
    sql: `SELECT COALESCE(SUM(r.total), 0) AS returns FROM returns r JOIN transactions t ON t.id = r.original_transaction_id
          WHERE t.customer_id = ? AND COALESCE(r.status, '') != 'cancelled' AND strftime('${pi.fmt}', r.created_at, '${off}') = ?`,
    args: [customerId, pi.key],
  });
  const purchases = r2(p.purchases), returns = r2(r.returns);
  return { sales: Number(p.sales) || 0, purchases, returns, used: r2(Math.max(0, purchases - returns)), discount_given: r2(p.discount_given) };
}

// Everything the POS and the employee form show about a staff account.
async function staffStatus(db, customerId, { periodKey } = {}) {
  const emp = await staffAccountFor(db, customerId);
  if (!emp) return null;
  await refreshStoreTz();
  const settings = await staffSettings(db);
  const pi = periodInfo(settings.period, periodKey);
  const u = await usage(db, customerId, pi);
  const limit = limitFor(emp, settings);
  return {
    customer_id: Number(customerId),
    employee_id: emp.employee_id,
    employee_name: `${emp.first_name} ${emp.last_name}`.trim(),
    employee_active: !!emp.active,
    tier: emp.staff_purchase_tier === 'manager' ? 'manager' : 'staff',
    own_limit: emp.staff_purchase_limit != null,
    limit,
    discount_pct: settings.discount_pct,
    period: settings.period,
    period_key: pi.key,
    period_label: pi.label,
    ...u,
    remaining: r2(Math.max(0, limit - u.used)),
  };
}

// Checks a staff-account sale; `db` may be the sale's write transaction so
// the limit is read with the sale. Returns { error, code } or null.
//   value — what this sale adds to "used" (see top of file).
async function staffSaleError(db, { staff, customerId, cashierId, methods, lineDiscount, value }) {
  const name = `${staff.first_name} ${staff.last_name}`.trim();
  if (!staff.active) return { code: 'staff_inactive', error: `${name} is no longer an active employee, so staff purchases on this account are closed` };
  if (cashierId && Number(cashierId) === Number(staff.employee_id)) {
    return { code: 'staff_self_sale', error: 'You can\'t ring up a staff purchase on your own account — another cashier must process it' };
  }
  if (methods.some(m => m !== 'cash')) return { code: 'staff_cash_only', error: 'Staff purchases are cash only' };
  if (lineDiscount) return { code: 'staff_line_discount', error: 'Staff purchases get the staff discount only — remove the line discounts' };
  const status = await staffStatus(db, customerId);
  if (value - status.remaining > 0.005) {
    return { code: 'staff_limit', error: `This purchase (${value.toFixed(2)}) would take ${name} over their ${status.period === 'year' ? 'yearly' : 'monthly'} staff purchase limit of ${status.limit.toFixed(2)}. Used in ${status.period_label}: ${status.used.toFixed(2)}; left: ${status.remaining.toFixed(2)}.` };
  }
  return null;
}

// The Staff Purchases report: every staff account for a period.
async function staffReport(db, periodKey) {
  await refreshStoreTz();
  const settings = await staffSettings(db);
  if (periodKey && !(settings.period === 'year' ? /^\d{4}$/ : /^\d{4}-\d{2}$/).test(periodKey)) {
    throw Object.assign(new Error(settings.period === 'year' ? 'Period must be a year, e.g. 2026' : 'Period must be a month, e.g. 2026-11'), { status: 400 });
  }
  const pi = periodInfo(settings.period, periodKey);
  const { rows } = await db.execute({
    sql: `SELECT c.id AS customer_id, c.customer_number, e.id AS employee_id, e.employee_number, e.first_name, e.last_name, e.active,
            e.staff_purchase_tier, e.staff_purchase_limit
          FROM customers c JOIN employees e ON e.id = c.staff_employee_id ORDER BY e.first_name, e.last_name`,
    args: [],
  });
  const accounts = [];
  for (const row of rows) {
    const u = await usage(db, row.customer_id, pi);
    const limit = limitFor(row, settings);
    accounts.push({
      customer_id: row.customer_id, customer_number: row.customer_number,
      employee_id: row.employee_id, employee_number: row.employee_number,
      employee_name: `${row.first_name} ${row.last_name}`.trim(), employee_active: !!row.active,
      tier: row.staff_purchase_tier === 'manager' ? 'manager' : 'staff', own_limit: row.staff_purchase_limit != null,
      limit, ...u, remaining: r2(Math.max(0, limit - u.used)),
    });
  }
  return { period: settings.period, period_key: pi.key, period_label: pi.label, discount_pct: settings.discount_pct, accounts };
}

module.exports = { staffSettings, staffAccountFor, staffStatus, staffSaleError, staffReport };
