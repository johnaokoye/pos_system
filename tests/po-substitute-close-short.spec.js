import { test, expect } from './fixtures.js';

// Receiving a PO: another SKU sent in place of part of a line becomes its own
// line at the ordered cost (one receipt, one bill), reversing the receipt
// folds it back; Close Short takes what won't come off the PO, Reopen puts it back.
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

async function approvedPO(page, approver, supplier, items) {
  const po = await api(page, 'POST', '/purchase-orders', { supplier_id: supplier.id, branch_id: 1, items });
  await api(page, 'PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' });
  await login(page, approver);
  await api(page, 'PATCH', `/purchase-orders/${po.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  return api(page, 'GET', `/purchase-orders/${po.id}`);
}

const branchQty = async (page, productId) => {
  const rows = await api(page, 'GET', `/products?branch_id=1&search=${encodeURIComponent((await api(page, 'GET', `/products/${productId}`)).sku)}`);
  return Number(rows.find(p => p.id === productId)?.stock_qty || 0);
};

test('substitute at receiving, reversal folds it back, close short and reopen', async ({ page }) => {
  const s = `${Date.now()}`;
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const approver = `sub${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Sub', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const supplier = await api(page, 'POST', '/suppliers', { name: `Sub Supplier ${s}`, sync_ap: 1 });
  const blue = await api(page, 'POST', '/products', { name: `Subtest Shirt Blue ${s}`, sku: `SBL${s}`, price: 100, cost: 40, tax_rate: 0, stock_qty: 0, active: 1 });
  const red = await api(page, 'POST', '/products', { name: `Subtest Shirt Red ${s}`, sku: `SRD${s}`, price: 100, cost: 35, tax_rate: 0, stock_qty: 0, active: 1 });
  const cap = await api(page, 'POST', '/products', { name: `Subtest Cap ${s}`, sku: `SCP${s}`, price: 30, cost: 10, tax_rate: 0, stock_qty: 0, active: 1 });

  let po = await approvedPO(page, approver, supplier, [{ product_id: blue.id, quantity: 6, unit_cost: 40 }, { product_id: cap.id, quantity: 4, unit_cost: 10 }]);
  const blueLine = po.items.find(i => i.product_id === blue.id), capLine = po.items.find(i => i.product_id === cap.id);
  expect(po.total).toBeCloseTo(280, 2);

  // Refused: more than is still to come, the same item, or a substitute of a substitute.
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { items: [{ item_id: blueLine.id, quantity_received: 5 }], substitutes: [{ item_id: blueLine.id, product_id: red.id, quantity: 2 }] })).toMatch(/still to come/);
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { substitutes: [{ item_id: blueLine.id, product_id: blue.id, quantity: 1 }] })).toMatch(/different item/);

  // Through the screen: 5 blue + 1 red in place of the 6th, and the caps.
  await page.evaluate(id => App.showReceivePO(id), po.id);
  await expect(page.locator(`#recv-${blueLine.id}`)).toHaveValue('6');
  await page.locator(`#recv-subs-${blueLine.id} + button:has-text("+ Substitute")`).click();
  await expect(page.locator(`#recv-${blueLine.id}`)).toHaveValue('5');
  const search = page.locator(`#recv-subs-${blueLine.id} input[type=search]`);
  await search.fill(`SRD${s}`);
  await expect(page.locator(`#recv-subs-${blueLine.id}`)).toContainText(`Subtest Shirt Red ${s}`);
  await page.fill('#recv-invoice', `SUBINV-${s}`);
  await page.click('button:has-text("Confirm Receipt")');
  await expect(page.locator('.modal-title:has-text("Confirm Counts")')).toBeVisible();
  await expect(page.locator('.badge-pill:has-text("Substitute")')).toBeVisible();
  await page.click('button:has-text("Counts Are Correct")');
  await expect.poll(async () => (await api(page, 'GET', `/purchase-orders/${po.id}`)).status).toBe('received');

  po = await api(page, 'GET', `/purchase-orders/${po.id}`);
  const sub = po.items.find(i => i.product_id === red.id);
  expect(sub).toMatchObject({ substitute_for_item_id: blueLine.id, substitute_for_name: blue.name, quantity_ordered: 1, quantity_received: 1, unit_cost: 40, total: 40 });
  expect(po.items.find(i => i.id === blueLine.id)).toMatchObject({ quantity_ordered: 5, quantity_received: 5, quantity_substituted: 1, total: 200 });
  expect(po.total).toBeCloseTo(280, 2);
  expect(po.receipts).toHaveLength(1);
  expect(po.receipts[0].items).toHaveLength(3);
  const bill = await api(page, 'GET', `/payables/bills/${po.receipts[0].bill_id}`);
  expect(Number(bill.amount)).toBeCloseTo(280, 2);
  expect(await branchQty(page, red.id)).toBe(1);
  expect(await branchQty(page, blue.id)).toBe(5);
  expect(Number((await api(page, 'GET', `/products/${red.id}`)).cost)).toBeCloseTo(40, 4);

  // The PO view shows it.
  await page.evaluate(() => App.closeModal());
  await page.evaluate(id => App.viewPO(id), po.id);
  await expect(page.locator('.modal')).toContainText(`↳ Substitute for ${blue.name}`);
  await expect(page.locator('.modal')).toContainText('1 replaced by a substitute');
  await page.evaluate(() => App.closeModal());

  // Reversing the receipt folds the substitute back into the blue line.
  await api(page, 'POST', `/purchase-orders/${po.id}/receipts/${po.receipts[0].id}/reverse`, { reason: 'test' });
  po = await api(page, 'GET', `/purchase-orders/${po.id}`);
  expect(po.status).toBe('approved');
  expect(po.items.find(i => i.product_id === red.id)).toBeUndefined();
  expect(po.items.find(i => i.id === blueLine.id)).toMatchObject({ quantity_ordered: 6, quantity_received: 0, quantity_substituted: 0, total: 240 });
  expect(po.total).toBeCloseTo(280, 2);
  expect(await branchQty(page, red.id)).toBe(0);
  expect(po.receipts[0].items.some(i => i.product_id === red.id)).toBe(true); // history kept

  // Close short: 5 blue in, the 6th not coming; caps not yet in.
  await api(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { items: [{ item_id: blueLine.id, quantity_received: 5 }, { item_id: capLine.id, quantity_received: 4 }] });
  expect((await api(page, 'GET', `/purchase-orders/${po.id}`)).status).toBe('partial');
  expect(await attempt(page, 'POST', `/purchase-orders/${po.id}/items/${blueLine.id}/close-short`, {})).toMatch(/why/);
  await page.evaluate(id => App.viewPO(id), po.id);
  await page.click('button:has-text("Close Short (1)")');
  await page.fill('#po-close-short-reason', 'Supplier out of blue');
  await page.click('.modal-footer button:has-text("Close Short")');
  await expect.poll(async () => (await api(page, 'GET', `/purchase-orders/${po.id}`)).status).toBe('received');
  po = await api(page, 'GET', `/purchase-orders/${po.id}`);
  expect(po.items.find(i => i.id === blueLine.id)).toMatchObject({ quantity_ordered: 5, quantity_closed_short: 1, closed_short_reason: 'Supplier out of blue', total: 200 });
  expect(po.total).toBeCloseTo(240, 2);
  await expect(page.locator('.modal')).toContainText('1 closed short');

  // Reopen puts it back as still to come.
  page.once('dialog', d => d.accept());
  await page.click('button:has-text("Reopen")');
  await expect.poll(async () => (await api(page, 'GET', `/purchase-orders/${po.id}`)).status).toBe('partial');
  po = await api(page, 'GET', `/purchase-orders/${po.id}`);
  expect(po.items.find(i => i.id === blueLine.id)).toMatchObject({ quantity_ordered: 6, quantity_closed_short: 0, total: 240 });
  expect(po.total).toBeCloseTo(280, 2);

  // Closing every line of a PO with nothing received is refused — cancel it instead.
  const po2 = await approvedPO(page, approver, supplier, [{ product_id: cap.id, quantity: 2, unit_cost: 10 }]);
  expect(await attempt(page, 'POST', `/purchase-orders/${po2.id}/items/${po2.items[0].id}/close-short`, { reason: 'x' })).toMatch(/cancel the PO/);
});
