import { test, expect } from './fixtures.js';

// Work orders: Issue from Stock takes a part on the job out of the branch's
// stock, once per issue. Supplier-owned (consignment) stock is only used
// where the agreement allows work-order use, and is then billable to the
// supplier from the day it's issued (decision A4).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function login(page, username, password = 'pw-123456') {
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(() => App.currentUser && document.querySelector('#content').innerHTML.length > 0);
}
const branchStock = async (page, branchId, productId) => ((await api(page, 'GET', `/products?branch_id=${branchId}`)).find(p => p.id === productId) || {}).stock_qty;

test('issue parts from stock to a work order — consignment only where the agreement allows it', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const second = `wo${s}`;
  await api(page, 'POST', '/employees', { first_name: 'WO', last_name: 'Approver', username: second, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });

  // Two supplier-owned items (one agreement allows work-order use, one doesn't) and one owned item.
  const mk = (name, cost) => api(page, 'POST', '/products', { name: `${name} ${s}`, sku: `${name.slice(0, 3).toUpperCase()}${s}`, price: 90, cost, tax_rate: 0, stock_qty: 0, active: 1 });
  const notAllowed = await mk('Belt', 20), allowed = await mk('Filter', 30), owned = await mk('Screw', 2);
  await api(page, 'PATCH', `/products/${owned.id}/stock`, { adjustment: 5, reason: 'owned', branch_id: main.id });
  const agreements = [];
  for (const [item, allow] of [[notAllowed, false], [allowed, true]]) {
    const sup = await api(page, 'POST', '/suppliers', { name: `WO Supplier ${item.id} ${s}` });
    agreements.push(await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2025-01-01', ownership_terms: "Supplier's until used", allow_work_orders: allow, items: [{ product_id: item.id, cost: 25 }], submit: true }));
  }
  await login(page, second);
  for (const a of agreements) {
    await api(page, 'POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
    await api(page, 'POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  }
  await login(page, 'admin', '123456');
  for (const [a, item] of [[agreements[0], notAllowed], [agreements[1], allowed]]) {
    const o = await api(page, 'POST', '/consignment/orders', { agreement_id: a.id, branch_id: main.id, items: [{ product_id: item.id, quantity: 3 }] });
    const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN${a.id}`, items: [{ order_item_id: o.items[0].id, quantity: 3 }] });
    await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});
  }

  // A job with all three parts on it.
  const fee = await api(page, 'POST', '/products', { name: `Assessment ${s}`, sku: `AS${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Job', last_name: `Owner${s}`, phone: `876${s.slice(-7)}` });
  const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Service the mower', item_label: 'Mower', assessment_fee_product_id: fee.id });
  await api(page, 'PATCH', `/work-orders/${wo.id}/parts`, { items: [{ product_id: notAllowed.id, quantity: 1 }, { product_id: allowed.id, quantity: 2 }, { product_id: owned.id, quantity: 4 }] });

  // Not allowed under its agreement: refused, nothing moves.
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/parts/issue`, { product_id: notAllowed.id, quantity: 1, issue_key: `a${s}` })).toContain("doesn't allow work-order use");
  expect(await branchStock(page, main.id, notAllowed.id)).toBe(3);

  // Allowed: issued, billable to that supplier at the agreed cost; recorded once.
  const out = await api(page, 'POST', `/work-orders/${wo.id}/parts/issue`, { product_id: allowed.id, quantity: 2, issue_key: `b${s}` });
  expect(out.items.find(i => i.product_id === allowed.id).issued_qty).toBe(2);
  expect((await api(page, 'POST', `/work-orders/${wo.id}/parts/issue`, { product_id: allowed.id, quantity: 2, issue_key: `b${s}` })).duplicate).toBe(true);
  expect(await branchStock(page, main.id, allowed.id)).toBe(1);
  expect(await attempt(page, 'POST', `/work-orders/${wo.id}/parts/issue`, { product_id: allowed.id, quantity: 1, issue_key: `c${s}` })).toContain('Only 0 more');

  // Owned stock, through the screen.
  await page.evaluate(() => App.showSection('work-orders'));
  await page.evaluate(id => App.viewWorkOrder(id), wo.id);
  page.once('dialog', d => d.accept('3'));
  await page.locator('tr', { hasText: `Screw ${s}` }).getByRole('button', { name: 'Issue' }).click();
  await expect.poll(() => branchStock(page, main.id, owned.id)).toBe(2);

  // The parts list can't drop below what's been issued.
  expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/parts`, { items: [{ product_id: allowed.id, quantity: 1 }] })).toContain('already been issued');

  // The month's reconciliation bills the issued parts to the supplier who allowed it.
  const month = await page.evaluate(() => App._storeDay(new Date()).slice(0, 7));
  const rec = await api(page, 'POST', '/consignment/reconciliations', { agreement_id: agreements[1].id, period: month });
  const line = rec.lines.find(l => l.line_type === 'stock' && l.product_id === allowed.id);
  expect(line).toMatchObject({ receipts: 3, work_orders: -2, expected_closing: 1, work_order_qty: 2, work_order_value: 50, billable_qty: 2, billable_value: 50 });

  const check = await api(page, 'GET', '/consignment/lot-check');
  expect(check.mismatches.filter(m => [notAllowed.id, allowed.id, owned.id].includes(m.product_id))).toEqual([]);
});
