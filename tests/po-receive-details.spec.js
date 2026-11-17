import { test, expect } from './fixtures.js';

// Receiving a PO records the day the goods came in and the supplier's
// invoice # / date; the receipt's A/P bill carries the invoice # and is dated
// by the invoice (else the day received).
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

test('PO receiving records the date received and the supplier invoice', async ({ page }) => {
  const s = `${Date.now()}`;
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const approver = `rcv${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Recv', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const supplier = await api(page, 'POST', '/suppliers', { name: `Recv Supplier ${s}`, sync_ap: 1 });
  const product = await api(page, 'POST', '/products', { name: `Recv Item ${s}`, sku: `RCV${s}`, price: 100, cost: 40, tax_rate: 0, stock_qty: 0, active: 1 });
  const po = await api(page, 'POST', '/purchase-orders', { supplier_id: supplier.id, branch_id: 1, items: [{ product_id: product.id, quantity: 5, unit_cost: 40 }] });
  await api(page, 'PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' });
  await login(page, approver);
  await api(page, 'PATCH', `/purchase-orders/${po.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const full = await api(page, 'GET', `/purchase-orders/${po.id}`);
  const itemId = full.items[0].id;

  // A future date is refused.
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { received_date: '2999-01-01', items: [{ item_id: itemId, quantity_received: 1 }] })).toMatch(/future/);

  // Through the screen: part of it, received a few days back, with the invoice.
  await page.evaluate(id => App.showReceivePO(id), po.id);
  await expect(page.locator('#recv-date')).toBeVisible();
  await page.fill(`#recv-${itemId}`, '2');
  await page.fill('#recv-date', '2026-11-10');
  await page.fill('#recv-invoice', `INV-${s}`);
  await page.fill('#recv-invoice-date', '2026-11-09');
  await page.click('button:has-text("Confirm Receipt")');
  await expect(page.locator('.modal-title:has-text("Confirm Counts")')).toBeVisible();
  await expect(page.locator(`text=INV-${s}`)).toBeVisible();
  await page.click('button:has-text("Counts Are Correct")');
  await expect.poll(async () => (await api(page, 'GET', `/purchase-orders/${po.id}`)).receipts?.length).toBe(1);

  let r = (await api(page, 'GET', `/purchase-orders/${po.id}`)).receipts[0];
  expect(r).toMatchObject({ received_date: '2026-11-10', vendor_invoice_number: `INV-${s}`, invoice_date: '2026-11-09' });
  let bill = await api(page, 'GET', `/payables/bills/${r.bill_id}`);
  expect(bill).toMatchObject({ vendor_invoice_number: `INV-${s}`, bill_date: '2026-11-09' });

  // The rest with no invoice date: the bill is dated the day received.
  await api(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { received_date: '2026-11-12', vendor_invoice_number: `INV2-${s}`, items: [{ item_id: itemId, quantity_received: 3 }] });
  r = (await api(page, 'GET', `/purchase-orders/${po.id}`)).receipts[1];
  expect(r).toMatchObject({ received_date: '2026-11-12', vendor_invoice_number: `INV2-${s}`, invoice_date: null });
  bill = await api(page, 'GET', `/payables/bills/${r.bill_id}`);
  expect(bill).toMatchObject({ vendor_invoice_number: `INV2-${s}`, bill_date: '2026-11-12' });
});
