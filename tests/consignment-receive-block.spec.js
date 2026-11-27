import { test, expect } from './fixtures.js';

// Owner's rule: once consignment tracking has started, an item on a
// supplier's approved consignment agreement can't be received from that
// supplier on a purchase order or a receipt without a PO (that would make it
// Total Tools' stock and raise a bill) — it comes in through Consignment.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const attempt = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => `${e.data?.code || ''} ${e.message}`), [method, url, data]);
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

test('consignment items from their supplier are refused on a PO and a receipt without a PO', async ({ page }) => {
  const s = `${Date.now()}`;
  const groups = await api(page, 'GET', '/security-groups');
  const approver = `crb${s}`;
  await api(page, 'POST', '/employees', { first_name: 'Crb', last_name: 'Approver', username: approver, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });

  const sup = await api(page, 'POST', '/suppliers', { name: `Consign Supplier ${s}`, sync_ap: 1 });
  const other = await api(page, 'POST', '/suppliers', { name: `Other Supplier ${s}`, sync_ap: 1 });
  const consigned = await api(page, 'POST', '/products', { name: `Consigned Saw ${s}`, sku: `CS${s}`, price: 200, cost: 80, tax_rate: 0, stock_qty: 0, active: 1 });
  const plain = await api(page, 'POST', '/products', { name: `Plain Saw ${s}`, sku: `PS${s}`, price: 200, cost: 80, tax_rate: 0, stock_qty: 0, active: 1 });
  const a = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2026-01-01', ownership_terms: "Supplier's until sold", items: [{ product_id: consigned.id, cost: 75 }], submit: true });

  // Approved PO with both items, then the agreement approved.
  const po = await api(page, 'POST', '/purchase-orders', { supplier_id: sup.id, branch_id: 1, items: [{ product_id: consigned.id, quantity: 2, unit_cost: 80 }, { product_id: plain.id, quantity: 2, unit_cost: 80 }] });
  await api(page, 'PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' });
  await login(page, approver);
  await api(page, 'PATCH', `/purchase-orders/${po.id}/approve`, { signature: SIG });
  await api(page, 'POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
  await api(page, 'POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');

  const lines = (await api(page, 'GET', `/purchase-orders/${po.id}`)).items;
  const line = p => lines.find(l => l.product_id === p.id).id;
  // The consignment item is refused — alone or with others, and as a substitute.
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { items: [{ item_id: line(consigned), quantity_received: 2 }, { item_id: line(plain), quantity_received: 1 }] }))
    .toMatch(new RegExp(`^consignment_item Consigned Saw ${s} is on Consign Supplier ${s}'s consignment agreement ${a.agreement_number}`));
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { items: [], substitutes: [{ item_id: line(plain), product_id: consigned.id, quantity: 1 }] })).toMatch(/^consignment_item /);
  // The other item still comes in on the PO.
  expect(await attempt(page, 'PATCH', `/purchase-orders/${po.id}/receive`, { items: [{ item_id: line(plain), quantity_received: 2 }] })).toBe('accepted');
  expect((await api(page, 'GET', `/products/${consigned.id}`)).stock_qty).toBe(0);

  // Receipt without a PO: refused from that supplier, fine from another.
  expect(await attempt(page, 'POST', '/direct-receipts', { supplier_id: sup.id, branch_id: 1, items: [{ product_id: consigned.id, quantity: 1, unit_cost: 80 }] })).toMatch(/^consignment_item /);
  expect(await attempt(page, 'POST', '/direct-receipts', { supplier_id: other.id, branch_id: 1, items: [{ product_id: consigned.id, quantity: 1, unit_cost: 80 }] })).toBe('accepted');

  // Move to Consignment Order: the PO line's rest moves to a CON- order at the
  // PO's branch; the plain item already came in, so the PO stays (received).
  expect(await attempt(page, 'POST', `/purchase-orders/${po.id}/convert-to-consignment`, {})).toMatch(/Enter why/);
  const preview = await api(page, 'GET', `/purchase-orders/${po.id}/consignment-lines`);
  expect(preview.lines.map(l => [l.product_id, l.quantity_left, l.agreement_number])).toEqual([[consigned.id, 2, a.agreement_number]]);
  const moved = await api(page, 'POST', `/purchase-orders/${po.id}/convert-to-consignment`, { reason: 'Supplier confirmed consignment' });
  expect(moved.status).toBe('received');
  expect(moved.orders).toHaveLength(1);
  const after = await api(page, 'GET', `/purchase-orders/${po.id}`);
  const closed = after.items.find(i => i.product_id === consigned.id);
  expect([closed.quantity_ordered, closed.quantity_closed_short]).toEqual([0, 2]);
  expect(closed.closed_short_reason).toContain(moved.orders[0].order_number);
  expect(after.total).toBeCloseTo(160, 2);
  const order = await api(page, 'GET', `/consignment/orders/${moved.orders[0].id}`);
  expect([order.source_po_number, order.branch_id, order.items.map(i => [i.product_id, i.quantity_ordered])]).toEqual([po.po_number, 1, [[consigned.id, 2]]]);
  // ...and it comes in as the supplier's stock.
  const grn = await api(page, 'POST', `/consignment/orders/${order.id}/grns`, { delivery_note_number: `DN-${s}`, items: [{ order_item_id: order.items[0].id, quantity: 2 }] });
  await api(page, 'POST', `/consignment/grns/${grn.id}/approve`, {});
  expect((await api(page, 'GET', `/products?search=CS${s}&branch_id=1`)).find(p => p.id === consigned.id)).toMatchObject({ stock_qty: 3, consignment_qty: 2 }); // + the 1 bought from the other supplier
  expect((await api(page, 'GET', `/purchase-orders/${po.id}/consignment-lines`)).lines).toHaveLength(0);

  // A PO with nothing else on it is cancelled; one with an advance requested is refused.
  const po2 = await api(page, 'POST', '/purchase-orders', { supplier_id: sup.id, branch_id: 1, items: [{ product_id: consigned.id, quantity: 3, unit_cost: 80 }] });
  const po3 = await api(page, 'POST', '/purchase-orders', { supplier_id: sup.id, branch_id: 1, items: [{ product_id: consigned.id, quantity: 1, unit_cost: 80 }] });
  for (const p of [po2, po3]) await api(page, 'PATCH', `/purchase-orders/${p.id}/status`, { status: 'sent' });
  await login(page, approver);
  for (const p of [po2, po3]) await api(page, 'PATCH', `/purchase-orders/${p.id}/approve`, { signature: SIG });
  await login(page, 'admin', '123456');
  expect((await api(page, 'POST', `/purchase-orders/${po2.id}/convert-to-consignment`, { reason: 'consignment' })).status).toBe('cancelled');
  expect((await api(page, 'GET', `/purchase-orders/${po2.id}`)).status).toBe('cancelled');
  await api(page, 'POST', `/payables/payment-requests/from-po/${po3.id}`, { amount: 80, required_date: '2026-12-30' });
  expect(await attempt(page, 'POST', `/purchase-orders/${po3.id}/convert-to-consignment`, { reason: 'consignment' })).toMatch(/advances/);
  expect((await api(page, 'GET', `/purchase-orders/${po3.id}`)).items[0].quantity_ordered).toBe(1);

  // The PO view offers it.
  await page.evaluate(id => App.viewPO(id), po3.id);
  await expect(page.locator('#po-to-consignment')).toContainText('Move to Consignment Order (1)');
});
