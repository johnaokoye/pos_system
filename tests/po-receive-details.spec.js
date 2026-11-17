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

  // The PO list shows the invoice #s and finds the PO by one.
  const listed = (await api(page, 'GET', `/purchase-orders?q=INV2-${s}`));
  expect(listed.map(p => p.id)).toEqual([po.id]);
  expect(listed[0].invoice_numbers).toBe(`INV-${s}, INV2-${s}`);
  await page.evaluate(() => App.showSection('purchasing'));
  await expect(page.locator('#po-list tr', { hasText: po.po_number })).toContainText(`INV-${s}, INV2-${s}`);

  // An older receipt with no invoice: filled in afterwards from the PO view.
  const po2 = await api(page, 'POST', '/purchase-orders', { supplier_id: supplier.id, branch_id: 1, items: [{ product_id: product.id, quantity: 4, unit_cost: 40 }] });
  await api(page, 'PATCH', `/purchase-orders/${po2.id}/status`, { status: 'sent' });
  await login(page, approver);
  await api(page, 'PATCH', `/purchase-orders/${po2.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  const item2 = (await api(page, 'GET', `/purchase-orders/${po2.id}`)).items[0].id;
  await api(page, 'PATCH', `/purchase-orders/${po2.id}/receive`, { items: [{ item_id: item2, quantity_received: 4 }] });
  let rc = (await api(page, 'GET', `/purchase-orders/${po2.id}`)).receipts[0];
  expect(rc.vendor_invoice_number).toBeNull();
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po2.id}/receipts/${rc.id}/details`, { received_date: '2999-01-01' })).toMatch(/future/);

  await page.evaluate(id => App.viewPO(id), po2.id);
  await page.click('button:has-text("Add Invoice")');
  await page.fill('#rcd-date', '2026-11-03');
  await page.fill('#rcd-invoice', `OLD-${s}`);
  await page.fill('#rcd-invoice-date', '2026-11-02');
  await page.click('.modal button:has-text("Save")');
  await expect(page.locator('text=Invoice details updated')).toBeVisible();
  rc = (await api(page, 'GET', `/purchase-orders/${po2.id}`)).receipts[0];
  expect(rc).toMatchObject({ received_date: '2026-11-03', vendor_invoice_number: `OLD-${s}`, invoice_date: '2026-11-02' });
  bill = await api(page, 'GET', `/payables/bills/${rc.bill_id}`);
  expect(bill).toMatchObject({ vendor_invoice_number: `OLD-${s}`, bill_date: '2026-11-02' });
  expect((await api(page, 'GET', `/purchase-orders?q=OLD-${s}`)).map(p => p.id)).toEqual([po2.id]);

  // A PO received before receipts were logged has no receipt to carry the
  // invoice: it's recorded on the PO itself.
  expect(await attempt(page, 'POST', `/purchase-orders/${po2.id}/invoices`, { vendor_invoice_number: 'X' })).toMatch(/logged receipt/);
  const legacy = (await api(page, 'GET', '/purchase-orders?q=LEGACY-PO-1'))[0];
  await page.evaluate(id => App.viewPO(id), legacy.id);
  await page.click('button:has-text("+ Add Invoice")');
  await page.fill('#poi-invoice', `LEG-${s}`);
  await page.fill('#poi-invoice-date', '2026-02-27');
  await page.click('.modal button:has-text("Save")');
  await expect(page.locator(`text=LEG-${s}`)).toBeVisible();
  let lp = await api(page, 'GET', `/purchase-orders/${legacy.id}`);
  expect(lp.invoices[0]).toMatchObject({ vendor_invoice_number: `LEG-${s}`, invoice_date: '2026-02-27', received_date: '2026-03-01' });
  expect((await api(page, 'GET', `/purchase-orders?q=LEG-${s}`))[0]).toMatchObject({ id: legacy.id, invoice_numbers: `LEG-${s}` });
  await api(page, 'PUT', `/purchase-orders/${legacy.id}/invoices/${lp.invoices[0].id}`, { vendor_invoice_number: `LEG2-${s}` });
  lp = await api(page, 'GET', `/purchase-orders/${legacy.id}`);
  expect(lp.invoices[0]).toMatchObject({ vendor_invoice_number: `LEG2-${s}`, invoice_date: null });
  await api(page, 'DELETE', `/purchase-orders/${legacy.id}/invoices/${lp.invoices[0].id}`);
  expect((await api(page, 'GET', `/purchase-orders/${legacy.id}`)).invoices).toEqual([]);
});
