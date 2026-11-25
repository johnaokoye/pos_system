import { test, expect } from './fixtures.js';

// Reports pick days on the store clock (Settings → Store Time Zone), not the
// UTC day: date(created_at) put a sale made after 7pm Jamaica time on the
// next day. Every report answers for today, and the day-by-day ones label
// today's sales with the store day.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

const REPORTS = ['sales', 'top-products', 'by-category', 'inventory', 'dashboard', 'ar-collections', 'promotions',
  'lead-source-performance', 'customer-segments', 'loyalty-engagement', 'discount-card-utilization', 'customer-retention',
  'salesperson-leaderboard', 'quote-funnel', 'crm-pipeline', 'rental-utilization', 'cash-variance', 'credit-risk',
  'tax-collected', 'writeoffs', 'gross-margin', 'supplier-item-sales', 'items-sold', 'items-returned', 'zero-negative-stock',
  'rental-deposits', 'sales-by-department', 'sales-by-promotion', 'online-sales', 'hourly-sales', 'staff-purchases'];

test('every report runs for today on the store day', async ({ page }) => {
  const today = await page.evaluate(() => App._storeDay(new Date()));
  for (const r of REPORTS) {
    const res = await page.evaluate(async url => { const x = await fetch(url, { headers: { 'X-Pos-User': String(App.currentUser.id) } }); return { status: x.status, body: await x.text() }; }, `/api/reports/${r}?start=${today}&end=${today}`);
    expect(res.status, `${r}: ${res.body.slice(0, 200)}`).toBe(200);
  }
  // The screens' date filters take store days too.
  for (const url of [`/transactions?start=${today}&end=${today}`, `/transactions/returns?start=${today}&end=${today}`, `/transactions/customer-payments?start=${today}&end=${today}`,
    `/quotations?start=${today}&end=${today}`, `/purchase-orders?start=${today}&end=${today}`, `/purchase-requests?start=${today}&end=${today}`,
    `/direct-receipts?start=${today}&end=${today}`, `/accounts/payments?start=${today}&end=${today}`, '/accounts/stats',
    `/shop-use/requests?from=${today}&to=${today}`]) {
    await api(page, 'GET', url);
  }
  // With no dates the range ends today on the store clock.
  const sales = await api(page, 'GET', '/reports/sales');
  for (const d of sales.byDay) expect(d.date <= today).toBeTruthy();
  const tax = await api(page, 'GET', `/reports/tax-collected?start=${today}&end=${today}`);
  for (const d of tax.byDay || []) expect(d.date).toBe(today);
});

// Overdue flags (rentals, layaways, the overdue CRM activity) compare a due
// date with storeTodaySql() — the store-clock day in SQL, not date('now').
test('storeTodaySql is the store-clock day', async () => {
  const { storeTodaySql, storeToday } = (await import('../lib/storeTime.js')).default;
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: ':memory:' });
  const { rows: [r] } = await db.execute(`SELECT ${storeTodaySql()} AS d`);
  expect(r.d).toBe(storeToday());
});
