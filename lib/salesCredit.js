// Who a transaction belongs to for sales targets, and the target meters' periods.

// The customer's assigned salesperson (customers.salesperson_id), if they're
// still an active Salesperson. Takes the customer id as its one argument.
const CUSTOMER_SALESPERSON_SQL = `(SELECT e.id FROM customers c JOIN employees e ON e.id = c.salesperson_id AND e.active = 1 AND e.is_salesperson = 1 WHERE c.id = ?)`;

async function customerSalesperson(executor, customerId) {
  if (!customerId) return null;
  const { rows: [row] } = await executor.execute({ sql: `SELECT ${CUSTOMER_SALESPERSON_SQL} AS id`, args: [customerId] });
  return row?.id ?? null;
}

// The store-clock hour, day, Monday-based week and month a moment falls in.
function storePeriods(date, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date)) parts[p.type] = p.value;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const asUtc = new Date(`${day}T00:00:00Z`);
  asUtc.setUTCDate(asUtc.getUTCDate() - ((asUtc.getUTCDay() + 6) % 7));
  return { hourly: `${day} ${parts.hour}`, daily: day, weekly: asUtc.toISOString().slice(0, 10), monthly: day.slice(0, 7) };
}

// Sums rows ({ employee_id, total, created_at: Date }) into each employee's
// hourly/daily/weekly/monthly sales, on the store clock as of `now`.
function sumSalesByPeriod(rows, now, tz) {
  const current = storePeriods(now, tz);
  const totals = {};
  for (const r of rows) {
    const at = storePeriods(r.created_at, tz);
    const t = totals[r.employee_id] = totals[r.employee_id] || { hourly_sales: 0, daily_sales: 0, weekly_sales: 0, monthly_sales: 0 };
    for (const period of ['hourly', 'daily', 'weekly', 'monthly']) {
      if (at[period] === current[period]) t[`${period}_sales`] += Number(r.total) || 0;
    }
  }
  for (const t of Object.values(totals)) for (const k of Object.keys(t)) t[k] = parseFloat(t[k].toFixed(2));
  return totals;
}

module.exports = { CUSTOMER_SALESPERSON_SQL, customerSalesperson, sumSalesByPeriod };
