import { test, expect } from './fixtures.js';

// Goods received without a PO are linked to the PO raised for them instead of
// being reversed and received again: the PO shows them received with the
// receipt, supplier invoice and A/P bill; stock and cost don't move.
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

test('a receipt made without a PO is linked to the PO afterwards, and unlinked', async ({ page }) => {
  const s = `${Date.now()}`;
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const approver = `lnk${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Link', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const supplier = await api(page, 'POST', '/suppliers', { name: `Link Supplier ${s}`, sync_ap: 1 });
  const other = await api(page, 'POST', '/suppliers', { name: `Other Supplier ${s}`, sync_ap: 1 });
  const product = await api(page, 'POST', '/products', { name: `Link Item ${s}`, sku: `LNK${s}`, price: 100, cost: 40, tax_rate: 0, stock_qty: 0, active: 1 });
  const extra = await api(page, 'POST', '/products', { name: `Link Extra ${s}`, sku: `LNX${s}`, price: 100, cost: 40, tax_rate: 0, stock_qty: 0, active: 1 });

  // Goods came in first, with the supplier's invoice.
  const drc = await api(page, 'POST', '/direct-receipts', { supplier_id: supplier.id, branch_id: 1, vendor_invoice_number: `INV-${s}`, items: [{ product_id: product.id, quantity: 3, unit_cost: 45 }] });
  expect(drc.bill_id).toBeTruthy();
  const stockAfterReceipt = (await api(page, 'GET', `/products/${product.id}`)).stock_qty;

  // The POs raised afterwards (approved): the right one, one without the item, one from another supplier.
  const mkPo = async (supplierId, items) => {
    const po = await api(page, 'POST', '/purchase-orders', { supplier_id: supplierId, branch_id: 1, items });
    await api(page, 'PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' });
    return po;
  };
  const po = await mkPo(supplier.id, [{ product_id: product.id, quantity: 5, unit_cost: 45 }]);
  const wrongItem = await mkPo(supplier.id, [{ product_id: extra.id, quantity: 5, unit_cost: 45 }]);
  const wrongSupplier = await mkPo(other.id, [{ product_id: product.id, quantity: 5, unit_cost: 45 }]);
  // Not approved yet: refused.
  expect(await attempt(page, 'POST', `/direct-receipts/${drc.id}/link-po`, { po_id: po.id })).toContain('awaiting approval');
  await login(page, approver);
  for (const p of [po, wrongItem, wrongSupplier]) await api(page, 'PATCH', `/purchase-orders/${p.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');

  const cands = await api(page, 'GET', `/direct-receipts/${drc.id}/po-candidates`);
  expect(cands.find(c => c.id === po.id)).toMatchObject({ problems: [], matches: [{ quantity: 3 }] });
  expect(cands.find(c => c.id === wrongItem.id).problems[0]).toContain("isn't on");
  expect(cands.find(c => c.id === wrongSupplier.id)).toBeUndefined();
  expect(await attempt(page, 'POST', `/direct-receipts/${drc.id}/link-po`, { po_id: wrongSupplier.id })).toContain('another supplier');
  expect(await attempt(page, 'POST', `/direct-receipts/${drc.id}/link-po`, { po_id: wrongItem.id })).toContain("isn't on");

  // Linked through the screen.
  await page.evaluate(id => App.viewDirectReceipt(id), drc.id);
  await page.getByRole('button', { name: 'Link to PO' }).click();
  page.once('dialog', d => d.accept());
  await page.locator(`button[onclick^="App._linkDirectReceiptPO(${drc.id}, ${po.id},"]`).click();
  await expect(page.locator('.modal').first()).toContainText(`${po.po_number}`);

  const after = await api(page, 'GET', `/purchase-orders/${po.id}`);
  expect(after.status).toBe('partial');
  expect(after.items[0]).toMatchObject({ quantity_received: 3, quantity_unlogged: 0 });
  expect(after.linked_receipts).toHaveLength(1);
  expect(after.linked_receipts[0]).toMatchObject({ receipt_number: drc.receipt_number, vendor_invoice_number: `INV-${s}` });
  const billing = await api(page, 'GET', `/payables/po/${po.id}`);
  expect(billing.bills.map(b => b.id)).toEqual([drc.bill_id]);
  expect(billing.unbilled).toBe(0);
  const listed = (await api(page, 'GET', `/purchase-orders?q=INV-${s}`)).find(p => p.id === po.id);
  expect(listed.invoice_numbers).toContain(`INV-${s}`);
  // Stock didn't move again.
  expect((await api(page, 'GET', `/products/${product.id}`)).stock_qty).toBe(stockAfterReceipt);
  // Linked receipts can't be reversed or linked twice.
  expect(await attempt(page, 'POST', `/direct-receipts/${drc.id}/reverse`, { reason: 'x' })).toContain('unlink it first');
  expect(await attempt(page, 'POST', `/direct-receipts/${drc.id}/link-po`, { po_id: po.id })).toContain('already linked');

  // Unlinked: the PO and the bill go back as they were.
  expect(await attempt(page, 'POST', `/direct-receipts/${drc.id}/unlink-po`, {})).toContain('reason');
  const un = await api(page, 'POST', `/direct-receipts/${drc.id}/unlink-po`, { reason: 'wrong PO' });
  expect(un.po_id).toBeNull();
  const back = await api(page, 'GET', `/purchase-orders/${po.id}`);
  expect(back.status).toBe('approved');
  expect(back.items[0].quantity_received).toBe(0);
  expect(back.linked_receipts).toHaveLength(0);
  expect((await api(page, 'GET', `/payables/po/${po.id}`)).bills).toHaveLength(0);

  // Linking from the PO: the whole order received.
  const drc2 = await api(page, 'POST', '/direct-receipts', { supplier_id: supplier.id, branch_id: 1, vendor_invoice_number: `INV2-${s}`, items: [{ product_id: product.id, quantity: 2, unit_cost: 45 }] });
  await api(page, 'POST', `/direct-receipts/${drc.id}/link-po`, { po_id: po.id });
  await api(page, 'POST', `/direct-receipts/${drc2.id}/link-po`, { po_id: po.id });
  expect((await api(page, 'GET', `/purchase-orders/${po.id}`)).status).toBe('received');
  const drc3 = await api(page, 'POST', '/direct-receipts', { supplier_id: supplier.id, branch_id: 1, items: [{ product_id: product.id, quantity: 1, unit_cost: 45 }] });
  expect(await attempt(page, 'POST', `/direct-receipts/${drc3.id}/link-po`, { po_id: po.id })).toContain('fully received');
});
