const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission, can } = require('../lib/permissions');

// "Current sales" per period uses transactions.employee_id (who actually
// rang up the sale) — deliberately not the commission-credit chain
// (quotations.original_employee_id) a reassigned quote's sale uses
// elsewhere in this app. A target tracks a salesperson's own selling
// activity, a different question from whose commission a sale counts
// toward. Bounded to the last 31 days so the query never has to scan a
// store's full transaction history just to answer "what happened this
// hour/day/week/month" — 31 days safely covers the current month from
// any day within it.
const CURRENT_SALES_SELECT = `
  SELECT employee_id,
    COALESCE(SUM(CASE WHEN strftime('%Y-%m-%d %H', created_at) = strftime('%Y-%m-%d %H', 'now') THEN total ELSE 0 END), 0) as hourly_sales,
    COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN total ELSE 0 END), 0) as daily_sales,
    COALESCE(SUM(CASE WHEN strftime('%Y-%W', created_at) = strftime('%Y-%W', 'now') THEN total ELSE 0 END), 0) as weekly_sales,
    COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN total ELSE 0 END), 0) as monthly_sales
  FROM transactions
  WHERE status = 'completed' AND employee_id IS NOT NULL AND date(created_at) >= date('now', '-31 days')
  GROUP BY employee_id`;

// A plain salesperson (no sales_manager/reports) only ever sees their own
// numbers, regardless of what they ask for — same "mine" scoping pattern
// routes/reports.js's /dashboard endpoint already uses for is_salesperson.
function scopedEmployeeId(req) {
  const perms = req.employee && req.employee.permissions;
  const isSalesperson = !!(req.employee && req.employee.is_salesperson);
  const elevated = can(perms, 'sales_manager') || can(perms, 'reports');
  if (isSalesperson && !elevated) return req.employee.id;
  return null; // no forced scope — caller can see everyone
}

// Every salesperson (is_salesperson=1, active) with their targets (0 if
// never set) and current-period sales, for the CRM dashboard's target
// meters and the Reports → Sales "Salesperson Targets" report.
router.get('/', requireAuth, async (req, res) => {
  try {
    const forcedId = scopedEmployeeId(req);
    const idFilter = forcedId || req.query.employee_id || null;
    const ef = idFilter ? ' AND e.id = ?' : '';
    const ep = idFilter ? [idFilter] : [];

    const { rows: employees } = await db.execute({
      sql: `SELECT e.id, e.first_name || ' ' || e.last_name as employee_name,
              COALESCE(st.hourly_target, 0) as hourly_target,
              COALESCE(st.daily_target, 0) as daily_target,
              COALESCE(st.weekly_target, 0) as weekly_target,
              COALESCE(st.monthly_target, 0) as monthly_target
            FROM employees e
            LEFT JOIN sales_targets st ON st.employee_id = e.id
            WHERE e.is_salesperson = 1 AND e.active = 1${ef}
            ORDER BY e.first_name`,
      args: ep,
    });
    const { rows: salesRows } = await db.execute({ sql: CURRENT_SALES_SELECT, args: [] });
    const salesMap = {};
    for (const row of salesRows) salesMap[row.employee_id] = row;

    for (const emp of employees) {
      const sales = salesMap[emp.id] || { hourly_sales: 0, daily_sales: 0, weekly_sales: 0, monthly_sales: 0 };
      emp.hourly_sales = sales.hourly_sales;
      emp.daily_sales = sales.daily_sales;
      emp.weekly_sales = sales.weekly_sales;
      emp.monthly_sales = sales.monthly_sales;
    }
    res.json(employees);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set/update one salesperson's targets — a current-value row, not
// date-ranged history (matches discount_card_types/cash_back_card_types'
// "one current rate" shape). Restricted to sales_manager: targets are set
// by management, not by the salesperson themselves, even though the GET
// above lets a salesperson see their own.
router.put('/:employeeId', requirePermission('sales_manager'), async (req, res) => {
  try {
    const { hourly_target, daily_target, weekly_target, monthly_target } = req.body;
    const { rows: [emp] } = await db.execute({ sql: 'SELECT id, is_salesperson FROM employees WHERE id = ? AND active = 1', args: [req.params.employeeId] });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (!emp.is_salesperson) return res.status(400).json({ error: 'Targets can only be set for employees flagged as a Salesperson' });

    const hourly = parseFloat(hourly_target) || 0;
    const daily = parseFloat(daily_target) || 0;
    const weekly = parseFloat(weekly_target) || 0;
    const monthly = parseFloat(monthly_target) || 0;
    const updatedBy = req.employee ? req.employee.id : null;

    await db.execute({
      sql: `INSERT INTO sales_targets (employee_id, hourly_target, daily_target, weekly_target, monthly_target, updated_by, updated_at)
            VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(employee_id) DO UPDATE SET hourly_target=?, daily_target=?, weekly_target=?, monthly_target=?, updated_by=?, updated_at=CURRENT_TIMESTAMP`,
      args: [req.params.employeeId, hourly, daily, weekly, monthly, updatedBy, hourly, daily, weekly, monthly, updatedBy],
    });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM sales_targets WHERE employee_id = ?', args: [req.params.employeeId] });
    res.json(row);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
