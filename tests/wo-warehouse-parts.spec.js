import { test, expect } from './fixtures.js';

// Work order parts come from the Warehouse (owner's rule): the WO branch's
// own stock first, then a transfer from the Warehouse, else Purchasing —
// never another store.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [method, url, data]);

test('work order parts are sourced from the Warehouse only', async ({ page }) => {
  const s = Date.now();
  const mkBranch = async (name, warehouse) => {
    const b = await api(page, 'POST', '/branches', { name: `${name} ${s}`, active: 1 });
    const row = (await api(page, 'GET', '/branches')).find(x => x.id === b.id);
    if (warehouse) await api(page, 'PUT', `/branches/${b.id}`, { ...row, is_warehouse: 1 });
    return b.id;
  };
  const whId = await mkBranch('Parts Warehouse', true);
  const storeId = await mkBranch('Other Store', false);
  try {
    const main = (await api(page, 'GET', '/branches')).find(b => b.id === 1);
    const part = await api(page, 'POST', '/products', { sku: `WP-${s}`, name: `Drive belt ${s}`, price: 500, cost: 200, tax_rate: 15 });
    await api(page, 'PATCH', `/products/${part.id}/stock`, { adjustment: 1, branch_id: main.id, reason: 'test' });
    await api(page, 'PATCH', `/products/${part.id}/stock`, { adjustment: 3, branch_id: whId, reason: 'test' });
    await api(page, 'PATCH', `/products/${part.id}/stock`, { adjustment: 9, branch_id: storeId, reason: 'test' });
    const fee = await api(page, 'POST', '/products', { name: `Assess W ${s}`, sku: `AW${s}`, price: 1000, cost: 0, tax_rate: 0, is_service: 1, active: 1 });
    const cust = await api(page, 'POST', '/customers', { address: '1 Test Road', first_name: 'Wh', last_name: `Parts${s}`, phone: `871${String(s).slice(-7)}` });
    const wo = await api(page, 'POST', '/work-orders', { customer_id: cust.id, employee_id: 1, branch_id: main.id, description: 'Mower belt', item_label: 'Mower', assessment_fee_product_id: fee.id });

    // Another store can't supply it.
    expect(await attempt(page, 'PATCH', `/work-orders/${wo.id}/parts`, { items: [{ product_id: part.id, quantity: 5, sources: [{ branch_id: main.id, quantity: 1 }, { branch_id: storeId, quantity: 4 }] }] }))
      .toContain('come from the Warehouse');

    // The screen offers only the Warehouse and fills in what it holds; the rest goes to Purchasing.
    await page.evaluate(() => App.showSection('work-orders'));
    await page.evaluate(id => App.viewWorkOrder(id), wo.id);
    await page.getByRole('button', { name: '+ Add Part' }).click();
    await page.evaluate(id => App._selectWOPartOption(0, id), part.id);
    await page.fill('#wop-qty-0', '5');
    await page.locator('#wop-qty-0').dispatchEvent('input');
    const alloc = page.locator('#wo-part-alloc-0');
    await expect(alloc).toContainText(`Transfer from Parts Warehouse ${s}`);
    await expect(alloc).not.toContainText(`Other Store ${s}`);
    await expect(page.locator(`#wo-part-alloc-0-b${whId}`)).toHaveValue('3');
    await expect(page.locator('#wo-part-alloc-0-remainder')).toHaveText('1');
    await page.getByRole('button', { name: 'Confirm Parts' }).click();
    await expect(page.locator('.modal')).toContainText('Drive belt');

    // Confirming raised a Warehouse → WO branch transfer for 3 and a purchase request for 1.
    const full = await api(page, 'GET', `/work-orders/${wo.id}`);
    const srcs = full.items[0].sources || [];
    expect(srcs.map(x => [x.branch_id, x.quantity]).sort()).toEqual([[main.id, 1], [whId, 3], [null, 1]].sort());
    const trf = srcs.find(x => x.branch_id === whId);
    expect(trf.transfer_id).toBeTruthy();
    const transfer = await api(page, 'GET', `/transfers/${trf.transfer_id}`);
    expect([transfer.from_branch_id, transfer.to_branch_id]).toEqual([whId, main.id]);
    expect(srcs.find(x => x.branch_id === null).purchase_request_item_id).toBeTruthy();
  } finally {
    for (const id of [whId, storeId]) {
      const row = (await api(page, 'GET', '/branches')).find(b => b.id === id);
      if (row) await api(page, 'PUT', `/branches/${id}`, { ...row, is_warehouse: 0, active: 0 });
    }
  }
});
