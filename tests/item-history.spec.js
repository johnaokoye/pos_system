import { test, expect } from './fixtures.js';

// Reports > Inventory > Item Transaction History (GET /reports/item-history).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('item history: every movement of one item at a location, in and out, matching on hand', async ({ page }) => {
  const stamp = Date.now();
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0 && !Number(b.is_warehouse));
  const p = await api(page, 'POST', '/products', { sku: `ITH-${stamp}`, name: `History Drill ${stamp}`, price: 40, cost: 15, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 20, branch_id: main.id, reason: 'opening count' });
  const cust = await api(page, 'POST', '/customers', { address: '1 Test Road', first_name: 'Ith', last_name: `Cust ${stamp}`, phone: `86${String(stamp).slice(-8)}`, customer_type: 'cash', force: true });
  const sell = qty => api(page, 'POST', '/transactions', { customer_id: cust.id, items: [{ product_id: p.id, quantity: qty }], branch_id: main.id, employee_id: 1, payment_method: 'cash', amount_tendered: 10000 });
  const sale = await sell(3);
  const voided = await sell(1);
  const group = await api(page, 'POST', '/security-groups', { name: `ITH ${stamp}`, permissions: { void_transactions: true, returns_override: true } });
  const pin = `${stamp}`.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Ith', last_name: `Mgr${stamp}`, username: `ith${stamp}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await api(page, 'PATCH', `/transactions/${voided.id}/void`, { pin, reason: 'test' });
  const full = await api(page, 'GET', `/transactions/${sale.id}`);
  await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: full.items[0].id, quantity: 1 }], resolution: 'credit_note', notes: 'test', override_pin: pin });
  const quick = await api(page, 'POST', '/transfers/quick', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: p.id, quantity: 5 }] });
  await api(page, 'POST', '/transfers', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: p.id, quantity: 2 }] }); // a request: not sent

  const today = await page.evaluate(() => App._storeDay(new Date()));
  const d = await api(page, 'GET', `/reports/item-history?item=ITH-${stamp}&start=${today}&end=${today}&branch_id=${main.id}`);
  expect(d.product.id).toBe(p.id);
  // In: 20 counted + 1 returned. Out: 3 sold + 5 transferred (the voided sale and the unsent request don't count).
  expect(d.totals).toMatchObject({ units_in: 21, units_out: 8, net: 13, units_sold: 3, sales: 1, sales_value: 120, units_returned: 1, transfers_out: 5, transfers_in: 0, adjustments: 20 });
  expect(d.on_hand_total).toBe(13); // the item started at nothing today, so on hand = the net change
  const types = d.rows.map(r => `${r.label}:${r.qty}:${r.counted}`);
  expect(types).toEqual(expect.arrayContaining(['Adjustment:20:true', 'Sale:-3:true', 'Sale (voided):-1:false', 'Return:1:true', 'Quick transfer out:-5:true', 'Transfer requested:-2:false']));
  expect(d.rows.find(r => r.label === 'Quick transfer out').reference).toBe(quick.transfer_number);

  // The other branch sees the transfer arrive.
  const o = await api(page, 'GET', `/reports/item-history?product_id=${p.id}&start=${today}&end=${today}&branch_id=${other.id}`);
  expect(o.totals).toMatchObject({ units_in: 5, units_out: 0, transfers_in: 5 });
  expect(o.on_hand_total).toBe(5);

  // Not an item number → suggestions to pick from.
  const miss = await page.evaluate(n => fetch(`/api/reports/item-history?item=${encodeURIComponent(n)}`).then(async r => ({ status: r.status, body: await r.json() })), `History Drill ${stamp}`);
  expect(miss.status).toBe(404);
  expect(miss.body.matches.map(m => m.id)).toContain(p.id);

  // The tile: search by name, pick the suggestion, see the rows.
  await page.evaluate(() => App.showSection('reports-inventory'));
  await page.locator('.card', { hasText: 'Item Transaction History' }).getByRole('button', { name: 'View Report' }).click();
  await page.fill('#ith-item', `History Drill ${stamp}`);
  await page.selectOption('#ith-branch', String(main.id));
  await page.locator('.modal').getByRole('button', { name: 'Generate' }).click();
  await page.locator('#rpt-modal-content').getByRole('button', { name: new RegExp(`ITH-${stamp}`) }).click();
  const content = page.locator('#rpt-modal-content');
  await expect(content).toContainText(`History Drill ${stamp}`);
  await expect(content).toContainText(quick.transfer_number);
  await expect(content).toContainText('Sale (voided)');
  await expect(content).toContainText('Transfer requested');
});
