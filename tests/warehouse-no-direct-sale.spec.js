import { test, expect } from './fixtures.js';

// Nothing is sold straight from a warehouse branch, even by someone with
// multi-branch access: the POS doesn't offer it and the server refuses a sale,
// hold or layaway there. A store sells warehouse stock with Get from here.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);

test('a warehouse branch can only supply a store sale through Get from here', async ({ page }) => {
  const s = Date.now();
  const wh = await api(page, 'POST', '/branches', { name: `Warehouse ${s}`, active: 1 });
  const whId = wh.id;
  const whRow = (await api(page, 'GET', '/branches')).find(b => b.id === whId);
  await api(page, 'PUT', `/branches/${whId}`, { ...whRow, is_warehouse: 1 });
  try {
    const store = (await api(page, 'GET', '/branches')).find(b => b.id === 1);
    const p = await api(page, 'POST', '/products', { sku: `WH-${s}`, name: `Warehouse Item ${s}`, price: 100, cost: 40, tax_rate: 0 });
    await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 5, branch_id: whId, reason: 'test' });
    const cust = await api(page, 'POST', '/customers', { first_name: 'Wh', last_name: `Cust ${s}`, phone: `876${String(s).slice(-7)}` });

    // Server: no sale, hold or layaway at the warehouse.
    const items = [{ product_id: p.id, quantity: 1 }];
    expect(await refused(page, 'POST', '/transactions', { items, branch_id: whId, employee_id: 1, payment_method: 'cash', amount_tendered: 100 })).toContain('is a warehouse');
    expect(await refused(page, 'POST', '/transactions/hold', { items, branch_id: whId, employee_id: 1 })).toContain('is a warehouse');
    expect(await refused(page, 'POST', '/layaway/plans', { customer_id: cust.id, branch_id: whId, employee_id: 1, items, payment_method: 'cash', amount_tendered: 20 })).toContain('is a warehouse');

    // POS: the admin (multi-branch) can't pick the warehouse.
    await page.goto('/');
    await page.waitForFunction(() => App.currentUser);
    expect(await page.evaluate(id => App.currentUser.branches.some(b => b.id === id), whId)).toBe(true);
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForFunction(() => document.getElementById('pos-branch-bar')?.textContent.length > 0);
    expect(await page.locator(`#pos-branch-select option[value="${whId}"]`).count()).toBe(0);
    expect(await page.evaluate(id => App._posBranches().some(b => b.id === id), whId)).toBe(false);

    // Get from here still works: sold at the store, sent over from the warehouse.
    const sale = await api(page, 'POST', '/transactions', {
      items: [{ product_id: p.id, quantity: 2, transfer_from_branch_id: whId, transfer_qty: 2 }],
      branch_id: store.id, employee_id: 1, payment_method: 'cash', amount_tendered: 500,
    });
    expect(sale.sale_transfers).toHaveLength(1);
    const detail = await api(page, 'GET', `/transactions/${sale.id}`);
    expect(detail).toMatchObject({ branch_id: store.id, collection_status: 'awaiting_transfer' });
    expect(detail.sale_transfers[0].from_branch_name).toBe(whRow.name);

    // Held with a Get from here line: nothing requested until it's paid;
    // recalled, the line still comes from the warehouse and the sale raises it.
    const tooMany = await refused(page, 'POST', '/transactions/hold', { items: [{ product_id: p.id, quantity: 9, unit_price: 100, transfer_from_branch_id: whId, transfer_qty: 9 }], branch_id: store.id, employee_id: 1 });
    expect(tooMany).toContain('only has');
    const hold = await api(page, 'POST', '/transactions/hold', {
      items: [{ product_id: p.id, product_name: p.name, quantity: 1, unit_price: 100, tax_rate: 0, transfer_from_branch_id: whId, transfer_qty: 1 }],
      branch_id: store.id, employee_id: 1, customer_id: cust.id,
    });
    expect(hold.items[0]).toMatchObject({ transfer_from_branch_id: whId, transfer_qty: 1 });
    expect((await api(page, 'GET', `/transfers?status=requested`)).filter(t => t.transaction_id === hold.id)).toHaveLength(0);
    await page.evaluate(id => App.loadHeldOrder(id), hold.id);
    await expect(page.locator('text=1 coming from')).toBeVisible();
    const recalled = await page.evaluate(() => App.cart.map(i => ({ from: i.transfer_from_branch_id, qty: i.transfer_qty })));
    expect(recalled).toEqual([{ from: whId, qty: 1 }]);
    const sale2 = await api(page, 'POST', '/transactions', {
      items: [{ product_id: p.id, quantity: 1, transfer_from_branch_id: whId, transfer_qty: 1 }],
      hold_id: hold.id, customer_id: cust.id, branch_id: store.id, employee_id: 1, payment_method: 'cash', amount_tendered: 100,
    });
    expect(sale2.sale_transfers).toHaveLength(1);
    expect((await api(page, 'GET', `/transactions/${hold.id}`).catch(() => null))?.status ?? 'gone').not.toBe('hold');
  } finally {
    // Leave no warehouse behind for later specs.
    const row = (await api(page, 'GET', '/branches')).find(b => b.id === whId);
    await api(page, 'PUT', `/branches/${whId}`, { ...row, is_warehouse: 0, active: 0 });
  }
});

// Sales made at a branch before it became a warehouse stay reportable on
// their own: the report location filters list warehouses (labelled), while
// the POS still won't sell there.
test('reports can still be filtered to a warehouse branch', async ({ page }) => {
  const s = Date.now();
  const br = await api(page, 'POST', '/branches', { name: `Old Store ${s}`, active: 1 });
  try {
    const p = await api(page, 'POST', '/products', { sku: `WHR-${s}`, name: `Warehouse Report Item ${s}`, price: 100, cost: 40, tax_rate: 0 });
    await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 3, branch_id: br.id, reason: 'test' });
    await api(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 1 }], branch_id: br.id, employee_id: 1, payment_method: 'cash', amount_tendered: 100 });
    const row = (await api(page, 'GET', '/branches')).find(b => b.id === br.id);
    await api(page, 'PUT', `/branches/${br.id}`, { ...row, is_warehouse: 1 });

    const today = new Date().toISOString().slice(0, 10);
    const sales = await api(page, 'GET', `/reports/sales?start=2000-01-01&end=${today}&branch_id=${br.id}`);
    expect(sales.summary.transaction_count).toBe(1);

    await page.goto('/');
    await page.waitForFunction(() => App.currentUser);
    await page.evaluate(() => App.showSection('reports'));
    await expect(page.locator(`#rpt-branch option[value="${br.id}"]`)).toHaveText(`Old Store ${s} (Warehouse)`);
    await page.evaluate(() => App.showSection('pos'));
    await page.waitForFunction(() => document.getElementById('pos-branch-bar')?.textContent.length > 0);
    expect(await page.locator(`#pos-branch-select option[value="${br.id}"]`).count()).toBe(0);
  } finally {
    const row = (await api(page, 'GET', '/branches')).find(b => b.id === br.id);
    await api(page, 'PUT', `/branches/${br.id}`, { ...row, is_warehouse: 0, active: 0 });
  }
});
