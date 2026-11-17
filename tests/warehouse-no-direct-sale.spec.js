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
  } finally {
    // Leave no warehouse behind for later specs.
    const row = (await api(page, 'GET', '/branches')).find(b => b.id === whId);
    await api(page, 'PUT', `/branches/${whId}`, { ...row, is_warehouse: 0, active: 0 });
  }
});
