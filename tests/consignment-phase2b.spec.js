import { test, expect } from './fixtures.js';

// Consignment Phase 2, the rest: a layaway sets supplier-owned stock aside
// but only becomes billable once it's paid off (A4); shop use only reaches a
// supplier's stock if the agreement allows it (A4); a collect-later sale is
// handed over in parts, each handover recorded once.
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
const lots = async (page, productId, branchId) => (await api(page, 'GET', `/consignment/lots?product_id=${productId}&branch_id=${branchId}`)).map(l => [l.owner, l.qty_on_hand]);

// An item held only as supplier-owned stock (qty at the main branch), on an
// agreement approved by a second Administrator (who's also returned).
async function consignedItem(page, s, { qty, allowShopUse = false, cost = 100 }) {
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const other2 = `ap2${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Second', last_name: 'Admin', username: other2, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const item = await api(page, 'POST', '/products', { name: `Consigned ${s}`, sku: `CN${s}`, price: 200, cost: 80, tax_rate: 0, stock_qty: 0, active: 1 });
  const sup = await api(page, 'POST', '/suppliers', { name: `Consignor ${s}` });
  const a = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2026-01-01', ownership_terms: "Supplier's until sold", allow_shop_use: allowShopUse, items: [{ product_id: item.id, cost }], submit: true });
  await login(page, other2);
  await api(page, 'POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const o = await api(page, 'POST', '/consignment/orders', { agreement_id: a.id, branch_id: main.id, items: [{ product_id: item.id, quantity: qty }] });
  const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN${s}`, items: [{ order_item_id: o.items[0].id, quantity: qty }] });
  await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});
  return { item, main, other, agreement: a, approver: other2 };
}

test('a layaway sets supplier stock aside and becomes billable only when paid off; cancelling puts it back', async ({ page }) => {
  const s = `${Date.now()}`;
  const { item, main } = await consignedItem(page, s, { qty: 5, cost: 100 });
  const full = await api(page, 'GET', `/products/${item.id}`);
  await api(page, 'PUT', `/products/${item.id}`, { ...full, is_layaway_eligible: 1 });
  const cust = await api(page, 'POST', '/customers', { first_name: 'Lay', last_name: `Away${s}`, phone: `876${s.slice(-7)}` });

  const plan = await api(page, 'POST', '/layaway/plans', { customer_id: cust.id, branch_id: main.id, employee_id: 1, items: [{ product_id: item.id, quantity: 2 }], payment_method: 'cash', amount_tendered: 100 });
  expect(await lots(page, item.id, main.id)).toEqual([['consignment', 3]]);
  let alloc = await api(page, 'GET', `/consignment/allocations?plan_id=${plan.id}`);
  expect(alloc).toHaveLength(1);
  expect(alloc[0]).toMatchObject({ owner: 'consignment', qty: 2, qualified_on: null, unit_cost: null });

  // Paid off: billable now, at the agreed cost.
  const p = await api(page, 'GET', `/layaway/plans/${plan.id}`);
  await api(page, 'PATCH', `/layaway/plans/${plan.id}/payments`, { amount: Math.round((p.total - p.amount_paid) * 100) / 100, payment_method: 'cash', employee_id: 1 });
  alloc = await api(page, 'GET', `/consignment/allocations?plan_id=${plan.id}`);
  expect(alloc[0].qualified_on).toBeTruthy();
  expect(alloc[0]).toMatchObject({ unit_cost: 100 });

  // A second layaway cancelled: back on the supplier's receipt.
  const plan2 = await api(page, 'POST', '/layaway/plans', { customer_id: cust.id, branch_id: main.id, employee_id: 1, items: [{ product_id: item.id, quantity: 1 }], payment_method: 'cash', amount_tendered: 100 });
  expect(await lots(page, item.id, main.id)).toEqual([['consignment', 2]]);
  await api(page, 'PATCH', `/layaway/plans/${plan2.id}/cancel`, { reason: 'Changed mind', employee_id: 1 });
  expect(await lots(page, item.id, main.id)).toEqual([['consignment', 3]]);
  expect((await api(page, 'GET', `/consignment/allocations?plan_id=${plan2.id}`))[0]).toMatchObject({ released_qty: 1, qualified_on: null });
});

test("shop use can't take a supplier's stock unless the agreement allows it", async ({ page }) => {
  const s = `${Date.now()}`;
  const { item, main, approver } = await consignedItem(page, s, { qty: 3, allowShopUse: false });
  const dept = (await api(page, 'POST', '/shop-use/departments', { name: `Dept ${s}` })).name;
  const r = await api(page, 'POST', '/shop-use/requests', { category: 'cleaning', branch_id: main.id, source_branch_id: main.id, department: dept, reason: 'Testing', lines: [{ product_id: item.id, quantity: 1 }] });
  await api(page, 'POST', `/shop-use/requests/${r.id}/submit`, {});
  await login(page, approver);
  await api(page, 'POST', `/shop-use/requests/${r.id}/approve`, {});
  await login(page, 'admin', '123456');
  const req = await api(page, 'GET', `/shop-use/requests/${r.id}`);
  const msg = await attempt(page, 'POST', `/shop-use/requests/${r.id}/issues`, { issue_key: `k${s}`, lines: [{ line_id: req.lines[0].id, qty: 1 }], recipient_name: 'Cleaner', acknowledged: true });
  expect(msg).toContain("agreement doesn't allow it");
  expect(await lots(page, item.id, main.id)).toEqual([['consignment', 3]]);
  // Leave nothing waiting in anyone's Shop Use inbox.
  await api(page, 'POST', `/shop-use/requests/${r.id}/cancel`, { reason: 'Test done' });
});

test('a collect-later sale is handed over in parts, each handover recorded once', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const item = await api(page, 'POST', '/products', { name: `Collect ${s}`, sku: `CL${s}`, price: 50, cost: 20, tax_rate: 0, stock_qty: 0, active: 1 });
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 1, reason: 'here', branch_id: other.id });
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 5, reason: 'there', branch_id: main.id });
  // Sold 3 at the other branch: 1 here, 2 coming from the main branch.
  const sale = await api(page, 'POST', '/transactions', { items: [{ product_id: item.id, quantity: 3, transfer_from_branch_id: main.id, transfer_qty: 2 }], branch_id: other.id, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 });
  let row = (await api(page, 'GET', `/transactions/collections?branch_id=${other.id}`)).find(r => r.id === sale.id);
  expect(row.lines[0]).toMatchObject({ sold: 3, issued: 0, due: 3, available_now: 1 });

  // The 1 that's here goes now — recorded once even if sent twice.
  const line = row.lines[0].id;
  const out = await api(page, 'POST', `/transactions/${sale.id}/collection-issues`, { items: [{ transaction_item_id: line, quantity: 1 }], issue_key: `k${s}` });
  expect(out.collected).toBe(false);
  expect((await api(page, 'POST', `/transactions/${sale.id}/collection-issues`, { items: [{ transaction_item_id: line, quantity: 1 }], issue_key: `k${s}` })).duplicate).toBe(true);
  expect(await attempt(page, 'POST', `/transactions/${sale.id}/collection-issues`, { items: [{ transaction_item_id: line, quantity: 1 }], issue_key: `k2${s}` })).toContain('Only 0');
  row = (await api(page, 'GET', `/transactions/collections?branch_id=${other.id}`)).find(r => r.id === sale.id);
  expect(row.lines[0]).toMatchObject({ issued: 1, due: 2, available_now: 0 });

  // The other 2 arrive; Hand over records the rest and the sale is collected.
  const t = (await api(page, 'GET', '/transfers')).find(x => x.transaction_id === sale.id);
  await api(page, 'PATCH', `/transfers/${t.id}/send`, {});
  await api(page, 'PATCH', `/transfers/${t.id}/dispatch`, { driver_name: 'Driver' });
  const td = await api(page, 'GET', `/transfers/${t.id}`);
  await api(page, 'PATCH', `/transfers/${t.id}/receive`, { delivered_by_name: 'Driver', items: [{ item_id: td.items[0].id, quantity_received: 2 }] });
  await api(page, 'PATCH', `/transactions/${sale.id}/collected`, {});
  expect((await api(page, 'GET', `/transactions/${sale.id}`)).collection_status).toBe('collected');
  row = (await api(page, 'GET', `/transactions/collections?branch_id=${other.id}&include=collected`)).find(r => r.id === sale.id);
  expect(row.lines[0]).toMatchObject({ issued: 3, due: 0 });
});
