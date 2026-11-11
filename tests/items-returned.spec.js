import { test, expect } from './fixtures.js';

// Reports > Inventory > Items Returned (GET /reports/items-returned).
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);

test('items returned: how often, units, value, return rate and the customers', async ({ page }) => {
  const stamp = Date.now();
  const p = await api(page, 'POST', '/products', { sku: `RET-${stamp}`, name: `Returned Kettle ${stamp}`, price: 50, cost: 20, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 20, branch_id: 1, reason: 'test' });
  const cust = n => api(page, 'POST', '/customers', { first_name: 'Ret', last_name: `${n} ${stamp}`, phone: `87${String(stamp).slice(-7)}${n === 'A' ? 1 : 2}`, customer_type: 'cash', force: true });
  const a = await cust('A'), b = await cust('B');
  const sell = (c, qty) => api(page, 'POST', '/transactions', { customer_id: c.id, items: [{ product_id: p.id, quantity: qty }], branch_id: 1, employee_id: 1, payment_method: 'cash', amount_tendered: 10000 });
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = `${stamp}`.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Ret', last_name: 'Mgr', username: `ret${stamp}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  const ret = async (sale, qty, reason, resolution = 'credit_note') => {
    const full = await api(page, 'GET', `/transactions/${sale.id}`);
    return api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: full.items[0].id, quantity: qty }], resolution, notes: reason, override_pin: pin });
  };
  const saleA = await sell(a, 4), saleB = await sell(b, 6);
  await ret(saleA, 1, 'Leaks');
  await ret(saleA, 2, 'Still leaking');
  await ret(saleB, 1, 'Wrong colour');

  const today = await page.evaluate(() => App._storeDay(new Date()));
  const data = await api(page, 'GET', `/reports/items-returned?start=${today}&end=${today}&q=${encodeURIComponent(`RET-${stamp}`)}`);
  expect(data.items).toHaveLength(1);
  const item = data.items[0];
  expect(item).toMatchObject({ returns: 3, units: 4, value: 200, customer_count: 2, units_sold: 10, return_rate: 40 });
  const ca = item.customers.find(c => c.customer_id === a.id);
  expect(ca).toMatchObject({ returns: 2, units: 3, value: 150, last_reason: 'Still leaking' });
  expect(item.customers[0].customer_id).toBe(a.id); // most often first
  expect(data.summary).toMatchObject({ items: 1, returns: 3, customers: 2, units: 4, value: 200 });
  // Narrowed to refunds: none.
  expect((await api(page, 'GET', `/reports/items-returned?start=${today}&end=${today}&resolution=refund&q=${encodeURIComponent(`RET-${stamp}`)}`)).items).toHaveLength(0);

  // The tile opens it and lists the customers under the item.
  await page.evaluate(() => App.showSection('reports-inventory'));
  await page.locator('.card', { hasText: 'Items Returned' }).getByRole('button', { name: 'View Report' }).click();
  await page.fill('#irr-q', `RET-${stamp}`);
  await page.locator('.modal').getByRole('button', { name: 'Generate' }).click();
  await expect(page.locator('#rpt-modal-content')).toContainText(`Returned Kettle ${stamp}`);
  await expect(page.locator('#rpt-modal-content')).toContainText(`Ret A ${stamp}`);
  await expect(page.locator('#rpt-modal-content')).toContainText('Still leaking');
});
