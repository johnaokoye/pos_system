import { test, expect } from './fixtures.js';

// Consignment Phase 1: an agreement drafted by Purchasing and approved by
// Finance (with its revenue / GCT treatment), an order received in two
// deliveries through Consignment GRNs that put supplier-owned stock on hand
// only once approved, and dated stock receipts for Total Tools-owned stock
// from the day tracking starts.
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
const branchStock = async (page, branchId, productId) => ((await api(page, 'GET', `/products?branch_id=${branchId}`)).find(p => p.id === productId) || {}).stock_qty;

test('agreement → Finance approval → order → two GRNs → supplier-owned stock on hand', async ({ page }) => {
  const s = `${Date.now()}`;
  const admin = (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Administrator');
  const finance = `fin${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Fin', last_name: 'Ance', username: finance, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: admin.id, active: 1 });
  const supplier = await api(page, 'POST', '/suppliers', { name: `Consignor ${s}` });
  const item = await api(page, 'POST', '/products', { name: `Consigned Drill ${s}`, sku: `CD${s}`, price: 250, cost: 120, tax_rate: 0, stock_qty: 0, active: 1 });
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 3, reason: 'owned stock', branch_id: 1 });

  // Before tracking starts, a GRN can be entered but not approved.
  const status = await api(page, 'GET', '/consignment/status');
  if (!status.go_live) {
    expect(await attempt(page, 'POST', '/consignment/go-live', { confirm: 'yes' })).toContain('START');
    const started = await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });
    expect(started.lots).toBeGreaterThan(0);
  }
  // The owned stock on hand is one opening receipt.
  const opening = (await api(page, 'GET', `/consignment/lots?product_id=${item.id}&branch_id=1`));
  expect(opening).toHaveLength(1);
  expect(opening[0]).toMatchObject({ owner: 'owned', source_type: 'opening', qty_on_hand: 3 });

  // Agreement: drafted and submitted; can't be approved before Finance sets the treatment, nor by its author.
  const agr = await api(page, 'POST', '/consignment/agreements', { supplier_id: supplier.id, start_date: '2026-11-01', ownership_terms: "Supplier's until sold", shortage_responsibility: 'total_tools', items: [{ product_id: item.id, cost: 150 }], submit: true });
  expect(agr).toMatchObject({ status: 'submitted', items: [{ product_id: item.id, current_cost: 150 }] });
  await login(page, finance);
  expect(await attempt(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG })).toContain('revenue and output GCT');
  await api(page, 'POST', `/consignment/agreements/${agr.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard GCT on the full selling price' });
  // On the screen, Finance sees the treatment and can approve (the signature is drawn there; sent here).
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(id => App.viewConsAgreement(id), agr.id);
  await expect(page.locator('.modal')).toContainText('Principal');
  await expect(page.locator('.modal-footer').getByRole('button', { name: 'Approve' })).toBeEnabled();
  await api(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG });
  expect((await api(page, 'GET', `/consignment/agreements/${agr.id}`)).status).toBe('approved');
  await login(page, 'admin', '123456');
  expect(await attempt(page, 'POST', `/consignment/agreements/${agr.id}/approve`, { signature: SIG })).not.toBe('accepted');

  // A later cost applies from its date only (A8).
  await api(page, 'POST', `/consignment/agreements/${agr.id}/costs`, { product_id: item.id, cost: 160, effective_from: '2099-01-01' });
  expect((await api(page, 'GET', `/consignment/agreements/${agr.id}`)).items[0].current_cost).toBe(150);

  // Order 10; the first delivery brings 6.
  const order = await api(page, 'POST', '/consignment/orders', { agreement_id: agr.id, branch_id: 1, items: [{ product_id: item.id, quantity: 10 }] });
  const line = order.items[0].id;
  expect(await attempt(page, 'POST', `/consignment/orders/${order.id}/grns`, { items: [{ order_item_id: line, quantity: 6 }] })).toContain('delivery note');
  const g1 = await api(page, 'POST', `/consignment/orders/${order.id}/grns`, { delivery_note_number: `DN-${s}-1`, items: [{ order_item_id: line, quantity: 6 }] });
  expect(g1.status).toBe('pending');
  expect(await branchStock(page, 1, item.id)).toBe(3); // nothing moves until approved
  // Only 4 left once the pending 6 are counted.
  expect(await attempt(page, 'POST', `/consignment/orders/${order.id}/grns`, { delivery_note_number: 'DN-X', items: [{ order_item_id: line, quantity: 5 }] })).toContain('Only 4');
  await api(page, 'POST', `/consignment/grns/${g1.id}/approve`, {});
  expect(await branchStock(page, 1, item.id)).toBe(9);
  expect((await api(page, 'GET', `/consignment/orders/${order.id}`)).status).toBe('partial');

  // The second delivery, through the screen, then approved.
  await page.evaluate(() => App.showSection('consignment'));
  await page.evaluate(id => App.viewConsOrder(id), order.id);
  await page.locator('.cg-qty').fill('4');
  await page.fill('#cg-note', `DN-${s}-2`);
  await page.getByRole('button', { name: 'Enter GRN' }).click();
  await expect(page.locator('.modal-title')).toContainText('Consignment GRN CGRN-');
  await page.getByRole('button', { name: 'Approve GRN' }).click();
  await expect(page.locator('.modal')).toContainText('Approved');
  expect(await branchStock(page, 1, item.id)).toBe(13);
  expect((await api(page, 'GET', `/consignment/orders/${order.id}`)).status).toBe('received');

  // Receipts by owner, oldest first: the opening owned 3, then the supplier's 6 and 4.
  const lots = await api(page, 'GET', `/consignment/lots?product_id=${item.id}&branch_id=1`);
  expect(lots.map(l => [l.owner, l.qty_on_hand, l.agreement_number || null])).toEqual([['owned', 3, null], ['consignment', 6, agr.agreement_number], ['consignment', 4, agr.agreement_number]]);
  expect(lots[1]).toMatchObject({ supplier_name: supplier.name, unit_cost: 150 });

  // The consignment stock report: 10 at the agreed cost, kept apart from owned stock.
  const report = await api(page, 'GET', `/consignment/stock?agreement_id=${agr.id}`);
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0]).toMatchObject({ qty_on_hand: 10, agreed_cost: 150, value: 1500 });

  // A Total Tools-owned receipt after go-live gets its own dated receipt.
  await api(page, 'POST', '/direct-receipts', { supplier_id: supplier.id, branch_id: 1, items: [{ product_id: item.id, quantity: 2, unit_cost: 120 }] });
  const after = await api(page, 'GET', `/consignment/lots?product_id=${item.id}&branch_id=1`);
  expect(after.at(-1)).toMatchObject({ owner: 'owned', source_type: 'direct_receipt', qty_on_hand: 2 });
});
