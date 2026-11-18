import { test, expect } from './fixtures.js';

// A consignment agreement can settle every 14 days instead of monthly: its
// periods run 14 days at a time from its start date, and each is reconciled
// (and settled) on its own.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function login(page, username, password = 'pw-123456') {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}

test('an agreement settled every 14 days is reconciled in 14-day periods from its start', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
  const groups = await api(page, 'GET', '/security-groups');
  const approver = `ft${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Fort', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });

  const today = await page.evaluate(() => App._storeDay(new Date()));
  const start = addDays(today, -20); // period 1 = start..start+13 (ended), period 2 holds today
  const item = await api(page, 'POST', '/products', { name: `Fortnight Item ${s}`, sku: `FT${s}`, price: 250, cost: 60, tax_rate: 0, stock_qty: 0, active: 1 });
  const sup = await api(page, 'POST', '/suppliers', { name: `Fortnight Supplier ${s}` });
  expect(await attempt(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: start, ownership_terms: 'x', settlement_frequency: 'weekly', items: [{ product_id: item.id, cost: 100 }] })).toContain('every 14 days');
  const agr = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: start, ownership_terms: "Supplier's until sold", settlement_frequency: 'fortnightly', items: [{ product_id: item.id, cost: 100 }], submit: true });
  expect(agr.settlement_frequency).toBe('fortnightly');
  await login(page, approver);
  await api(page, 'POST', `/consignment/agreements/${agr.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const o = await api(page, 'POST', '/consignment/orders', { agreement_id: agr.id, branch_id: main.id, items: [{ product_id: item.id, quantity: 5 }] });
  const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN${s}`, items: [{ order_item_id: o.items[0].id, quantity: 5 }] });
  await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});
  await api(page, 'POST', '/transactions', { items: [{ product_id: item.id, quantity: 2 }], branch_id: main.id, employee_id: 1, payment_method: 'cash', amount_tendered: 5000 });

  // Its periods: 14 days each from the start, newest first.
  const { periods } = await api(page, 'GET', `/consignment/agreements/${agr.id}/periods`);
  expect(periods.map(p => [p.period, p.last, p.ended])).toEqual([[addDays(start, 14), addDays(start, 27), false], [start, addDays(start, 13), true]]);

  // Only its own periods: not a month, not a day off the 14-day cycle.
  expect(await attempt(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: today.slice(0, 7) })).toContain('every 14 days');
  expect(await attempt(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: addDays(start, 13) })).toContain('every 14 days');

  // The current period holds today's sale; the earlier one doesn't.
  const cur = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: addDays(start, 14) });
  const line = cur.lines.find(l => l.line_type === 'stock' && l.branch_id === main.id && l.product_id === item.id);
  expect(line).toMatchObject({ receipts: 5, sales: -2, pos_sales_qty: 2, billable_qty: 2, billable_value: 200 });
  expect(cur.period_label).toMatch(/ – /);
  expect(await attempt(page, 'POST', `/consignment/reconciliations/${cur.id}/approve`, { signature: SIG })).toContain("hasn't ended");
  const first = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: start });
  expect(first.lines.filter(l => l.billable_qty)).toHaveLength(0);
  expect(await attempt(page, 'POST', '/consignment/reconciliations', { agreement_id: agr.id, period: start })).toContain('already covers');

  // A monthly agreement still takes months only.
  const monthly = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: start, ownership_terms: 'x', items: [{ product_id: item.id, cost: 100 }] });
  expect(monthly.settlement_frequency).toBe('monthly');

  // The screen offers the agreement's periods.
  await page.evaluate(() => App.renderConsignment('recon'));
  await page.selectOption('#crn-agr', String(agr.id));
  await page.evaluate(() => App._consReconPeriods());
  await expect(page.locator('#crn-month option')).toHaveCount(2);
});
