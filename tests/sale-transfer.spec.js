import { test, expect } from './fixtures.js';

// Sold now, collected later (lib/saleTransfers.js): a POS line this branch is
// short of comes from another branch on a transfer request raised with the
// sale; when it's received the sale is ready to collect, then handed over.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);

async function setup(page) {
  const stamp = Date.now();
  let branches = (await api(page, 'GET', '/branches')).filter(b => b.active);
  if (branches.length < 2) {
    await api(page, 'POST', '/branches', { name: `Other ${stamp}`, active: 1 });
    branches = (await api(page, 'GET', '/branches')).filter(b => b.active);
  }
  const here = branches.find(b => b.id === 1) || branches[0];
  const there = branches.find(b => b.id !== here.id);
  const p = await api(page, 'POST', '/products', { sku: `XFER-${stamp}`, name: `Transfer Drill ${stamp}`, price: 100, cost: 40, tax_rate: 0 });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 1, branch_id: here.id, reason: 'test' });
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 5, branch_id: there.id, reason: 'test' });
  return { here, there, p };
}
const stockAt = async (page, productId) => {
  const full = await api(page, 'GET', `/products/${productId}`);
  return { global: full.stock_qty, by: Object.fromEntries((full.branch_stock || []).map(b => [b.branch_id, b.stock_qty])) };
};
const sell = (page, { here, there, p }, extra = {}) => api(page, 'POST', '/transactions', {
  items: [{ product_id: p.id, quantity: 3, transfer_from_branch_id: there.id, transfer_qty: 2 }],
  branch_id: here.id, employee_id: 1, payment_method: 'cash', amount_tendered: 1000, ...extra,
});

test('a sale with goods from another branch raises the transfer, and they are the customer\'s when they arrive', async ({ page }) => {
  const s = await setup(page);
  const { here, there, p } = s;

  // Not allowed: from this branch, or more than the other branch has.
  expect(await refused(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 3, transfer_from_branch_id: here.id, transfer_qty: 2 }], branch_id: here.id, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 })).toContain('already at this branch');
  expect(await refused(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 9, transfer_from_branch_id: there.id, transfer_qty: 8 }], branch_id: here.id, employee_id: 1, payment_method: 'cash', amount_tendered: 5000 })).toContain('only has 5');

  const sale = await sell(page, s);
  expect(sale.sale_transfers).toHaveLength(1);
  // The 1 here comes off now; the 2 from the other branch stay there until they arrive.
  expect(await stockAt(page, p.id)).toMatchObject({ global: 5, by: { [here.id]: 0, [there.id]: 5 } });
  const detail = await api(page, 'GET', `/transactions/${sale.id}`);
  expect(detail.collection_status).toBe('awaiting_transfer');
  expect(detail.sale_transfers[0]).toMatchObject({ status: 'requested', from_branch_name: there.name });
  expect(await refused(page, 'PATCH', `/transactions/${sale.id}/collected`, {})).toContain('Not everything has arrived');

  // The inventory team sends it, it travels, it's received here.
  const trf = detail.sale_transfers[0];
  const full = await api(page, 'GET', `/transfers/${trf.id}`);
  await api(page, 'PATCH', `/transfers/${trf.id}/send`, { items: full.items.map(i => ({ item_id: i.id, quantity: i.quantity_requested })) });
  expect((await stockAt(page, p.id)).by[there.id]).toBe(3);
  await api(page, 'PATCH', `/transfers/${trf.id}/dispatch`, { driver_name: 'Test Driver' });
  await api(page, 'PATCH', `/transfers/${trf.id}/receive`, { delivered_by_name: 'Test Driver', items: full.items.map(i => ({ item_id: i.id, quantity_received: 2 })) });

  // They're the customer's: this branch's stock stays at 0, overall at 3.
  expect(await stockAt(page, p.id)).toMatchObject({ global: 3, by: { [here.id]: 0, [there.id]: 3 } });
  const ready = (await api(page, 'GET', `/transactions/collections?branch_id=${here.id}`)).find(r => r.id === sale.id);
  expect(ready).toMatchObject({ collection_status: 'ready' });
  expect(ready.lines[0]).toMatchObject({ transfer_qty: 2, transfer_received_qty: 2 });

  await api(page, 'PATCH', `/transactions/${sale.id}/collection-contacted`, { note: 'Called' });
  await api(page, 'PATCH', `/transactions/${sale.id}/collected`, {});
  const done = await api(page, 'GET', `/transactions/${sale.id}`);
  expect(done).toMatchObject({ collection_status: 'collected', contact_note: 'Called' });
  expect((await api(page, 'GET', `/transactions/collections?branch_id=${here.id}`)).some(r => r.id === sale.id)).toBe(false);
});

test('voiding before the transfer is sent cancels it and puts back only what left this branch', async ({ page }) => {
  const s = await setup(page);
  const { here, there, p } = s;
  const sale = await sell(page, s);
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = `${Date.now()}`.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Void', last_name: 'Mgr', username: `vm${Date.now()}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await api(page, 'PATCH', `/transactions/${sale.id}/void`, { pin, reason: 'Customer changed mind' });
  expect(await stockAt(page, p.id)).toMatchObject({ global: 6, by: { [here.id]: 1, [there.id]: 5 } });
  const t = (await api(page, 'GET', `/transactions/${sale.id}`)).sale_transfers[0];
  expect(t.status).toBe('cancelled');
});

test('POS: short here, the other branches are offered and the line goes on the ticket from there', async ({ page }) => {
  const s = await setup(page);
  await page.evaluate(() => App.showSection('pos'));
  await page.waitForFunction(() => App.allProducts && App.allProducts.length);
  await page.evaluate(async id => { App.allProducts = await App.api('GET', `/products?active=1&for_sale=1&branch_id=${App.posBranch?.id || 1}`); }, s.p.id);
  await page.evaluate(id => App.addToCart(id, null, 3), s.p.id);
  await expect(page.locator('#obs-overlay')).toContainText(s.there.name);
  await expect(page.locator('#obs-note')).toContainText('2 from the branch you pick');
  await page.locator('#obs-overlay tr', { hasText: s.there.name }).getByRole('button', { name: 'Get from here' }).click();
  const line = await page.evaluate(() => App.cart[App.cart.length - 1]);
  expect(line).toMatchObject({ product_id: s.p.id, quantity: 3, transfer_from_branch_id: s.there.id, transfer_qty: 2 });
  await expect(page.locator('body')).toContainText(`2 coming from ${s.there.name}`);
});

test('a return before the goods arrive stops them being owed; they then arrive as ordinary stock', async ({ page }) => {
  const s = await setup(page);
  const { here, there, p } = s;
  const sale = await sell(page, s);
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = `${Date.now()}`.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Ret', last_name: 'Mgr', username: `rm${Date.now()}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  const detail = await api(page, 'GET', `/transactions/${sale.id}`);
  await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: detail.items[0].id, quantity: 2 }], resolution: 'refund', refund_method: 'card', notes: 'Only wanted one', override_pin: pin });
  // Nothing taken back onto this branch (they never came off), nothing owed any more.
  expect(await stockAt(page, p.id)).toMatchObject({ global: 5, by: { [here.id]: 0, [there.id]: 5 } });
  const after = await api(page, 'GET', `/transactions/${sale.id}`);
  expect(after.items[0]).toMatchObject({ transfer_qty: 0 });
  expect(after.collection_status).toBe('ready');

  // The request still goes ahead (someone may have sent it): arriving, it's ordinary stock here.
  const trf = after.sale_transfers[0];
  const full = await api(page, 'GET', `/transfers/${trf.id}`);
  await api(page, 'PATCH', `/transfers/${trf.id}/send`, { items: full.items.map(i => ({ item_id: i.id, quantity: i.quantity_requested })) });
  await api(page, 'PATCH', `/transfers/${trf.id}/dispatch`, { driver_name: 'Test Driver' });
  await api(page, 'PATCH', `/transfers/${trf.id}/receive`, { delivered_by_name: 'Test Driver', items: full.items.map(i => ({ item_id: i.id, quantity_received: 2 })) });
  expect(await stockAt(page, p.id)).toMatchObject({ global: 5, by: { [here.id]: 2, [there.id]: 3 } });
});

test('Collections lists the waiting order with its transfer', async ({ page }) => {
  const s = await setup(page);
  const sale = await sell(page, s);
  await page.evaluate(b => { App.posBranch = b; }, s.here);
  await page.evaluate(() => App.showCollections());
  const card = page.locator('#coll-list .card', { hasText: sale.transaction_number });
  await expect(card).toContainText('Awaiting goods on transfer');
  await expect(card).toContainText(`from ${s.there.name}`);
  await expect(card).toContainText('Requested');
});

test('an ordinary sale never shows in Collections, and a return leaves its online-order status alone', async ({ page }) => {
  const { here, p } = await setup(page);
  const sale = await api(page, 'POST', '/transactions', { items: [{ product_id: p.id, quantity: 1 }], branch_id: here.id, employee_id: 1, payment_method: 'cash', amount_tendered: 1000 });
  const before = await api(page, 'GET', `/transactions/${sale.id}`);
  const group = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager');
  const pin = `${Date.now()}`.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Ord', last_name: 'Mgr', username: `om${Date.now()}`, pin, password: 'pw-123456', must_change_password: 0, security_group_id: group.id, active: 1 });
  await api(page, 'POST', `/transactions/${sale.id}/return`, { items: [{ transaction_item_id: before.items[0].id, quantity: 1 }], resolution: 'refund', refund_method: 'card', notes: 'x', override_pin: pin });
  const after = await api(page, 'GET', `/transactions/${sale.id}`);
  expect(after.fulfillment_status).toBe(before.fulfillment_status);
  expect(after.collection_status).toBeNull();
  expect((await api(page, 'GET', '/transactions/collections')).some(r => r.id === sale.id)).toBe(false);
});
