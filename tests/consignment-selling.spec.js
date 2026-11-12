import { test, expect } from './fixtures.js';

// Consignment Phase 2: one item code held as Total Tools-owned stock and as
// stock from two suppliers. Sales take oldest receipt first and keep the
// supplier, agreement and cost; returns and voids put stock back on the
// receipt it came from; transfers carry ownership; a sale filled from
// another branch reserves that stock until it's sent; other stock changes
// keep the receipts in step.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
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
const lots = async (page, productId, branchId) => (await api(page, 'GET', `/consignment/lots?product_id=${productId}&branch_id=${branchId}`))
  .map(l => ({ owner: l.owner, agreement: l.agreement_number || null, src: l.source_type, on_hand: l.qty_on_hand, reserved: l.qty_reserved }));
const sell = (page, productId, branchId, quantity, extra = {}) => api(page, 'POST', '/transactions', { items: [{ product_id: productId, quantity, ...extra }], branch_id: branchId, employee_id: 1, payment_method: 'cash', amount_tendered: 100000 });

test('sales, returns, voids, transfers and reservations keep supplier ownership', async ({ page }) => {
  const s = `${Date.now()}`;
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const groups = await api(page, 'GET', '/security-groups');
  const finance = `cf${s}`, managerPin = s.slice(-6);
  await api(page, 'POST', '/employees', { first_name: 'Con', last_name: 'Finance', username: finance, pin: String(Number(managerPin) + 1).slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Administrator').id, active: 1 });
  await api(page, 'POST', '/employees', { first_name: 'Ret', last_name: 'Manager', username: `rm${s}`, pin: managerPin, password: 'pw-123456', must_change_password: 0, security_group_id: groups.find(g => g.name === 'Manager').id, active: 1 });
  if (!(await api(page, 'GET', '/consignment/status')).go_live) await api(page, 'POST', '/consignment/go-live', { confirm: 'START' });

  const item = await api(page, 'POST', '/products', { name: `Shared Saw ${s}`, sku: `SS${s}`, price: 300, cost: 120, tax_rate: 0, stock_qty: 0, active: 1 });
  // Owned stock first (2), then deliveries from two suppliers (5 and 3).
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: 2, reason: 'owned', branch_id: main.id });
  const agreements = [];
  for (const [name, cost, qty] of [['Supplier A', 150, 5], ['Supplier B', 90, 3]]) {
    const sup = await api(page, 'POST', '/suppliers', { name: `${name} ${s}` });
    const a = await api(page, 'POST', '/consignment/agreements', { supplier_id: sup.id, start_date: '2026-01-01', ownership_terms: "Supplier's until sold", items: [{ product_id: item.id, cost }], submit: true });
    agreements.push(a);
  }
  await login(page, finance);
  for (const a of agreements) {
    await api(page, 'POST', `/consignment/agreements/${a.id}/finance`, { revenue_treatment: 'principal', output_gct_treatment: 'Standard' });
    await api(page, 'POST', `/consignment/agreements/${a.id}/approve`, { signature: SIG });
  }
  await login(page, 'admin', '123456');
  const [A, B] = agreements.map(a => a.agreement_number);
  for (const [a, qty] of [[agreements[0], 5], [agreements[1], 3]]) {
    const o = await api(page, 'POST', '/consignment/orders', { agreement_id: a.id, branch_id: main.id, items: [{ product_id: item.id, quantity: qty }] });
    const g = await api(page, 'POST', `/consignment/orders/${o.id}/grns`, { delivery_note_number: `DN-${a.id}`, items: [{ order_item_id: o.items[0].id, quantity: qty }] });
    await api(page, 'POST', `/consignment/grns/${g.id}/approve`, {});
  }
  expect((await lots(page, item.id, main.id)).map(l => [l.owner, l.agreement, l.on_hand])).toEqual([['owned', null, 2], ['consignment', A, 5], ['consignment', B, 3]]);

  // A sale of 4: the owned 2 first (oldest), then 2 of Supplier A's at the agreed cost.
  const s1 = await sell(page, item.id, main.id, 4);
  let alloc = await api(page, 'GET', `/consignment/allocations?transaction_id=${s1.id}`);
  expect(alloc.map(a => [a.owner, a.agreement_number || null, a.qty, a.unit_cost])).toEqual([['owned', null, 2, 120], ['consignment', A, 2, 150]]);

  // A partial return (1, damaged): back on Supplier A's receipt, credited to A.
  const s1Full = await api(page, 'GET', `/transactions/${s1.id}`);
  const ret = await api(page, 'POST', `/transactions/${s1.id}/return`, { items: [{ transaction_item_id: s1Full.items[0].id, quantity: 1 }], resolution: 'refund', refund_method: 'card', notes: 'Bent blade', override_pin: managerPin, goods_condition: 'damaged' });
  alloc = await api(page, 'GET', `/consignment/allocations?transaction_id=${s1.id}`);
  expect(alloc.find(a => a.owner === 'consignment').returned_qty).toBe(1);
  expect((await api(page, 'GET', `/transactions/returns/${ret.id}`)).goods_condition).toBe('damaged');
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand])).toEqual([[A, 4], [B, 3]]);

  // A sale voided: everything back where it came from.
  const s2 = await sell(page, item.id, main.id, 2);
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand])).toEqual([[A, 2], [B, 3]]);
  await api(page, 'PATCH', `/transactions/${s2.id}/void`, { pin: managerPin, reason: 'Rang up twice' });
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand])).toEqual([[A, 4], [B, 3]]);

  // A quick transfer of 3 to the other branch takes A's oldest; it arrives as A's there.
  await api(page, 'POST', '/transfers/quick', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: item.id, quantity: 3 }] });
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand])).toEqual([[A, 1], [B, 3]]);
  expect((await lots(page, item.id, other.id)).map(l => [l.owner, l.agreement, l.src, l.on_hand])).toEqual([['consignment', A, 'transfer_in', 3]]);

  // A sale at the other branch of 5: 3 there, 2 from the main branch — reserved there at once (A5).
  const s3 = await sell(page, item.id, other.id, 5, { transfer_from_branch_id: main.id, transfer_qty: 2 });
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand, l.reserved])).toEqual([[A, 1, 1], [B, 3, 1]]);
  const transfer = (await api(page, 'GET', `/transfers?status=requested`)).find(t => t.transaction_id === s3.id) || (await api(page, 'GET', '/transfers')).find(t => t.transaction_id === s3.id);
  expect(transfer).toBeTruthy();
  // Sent: the reservation becomes the transfer; in transit until it arrives.
  await api(page, 'PATCH', `/transfers/${transfer.id}/send`, {});
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand, l.reserved])).toEqual([[B, 2, 0]]);
  await api(page, 'PATCH', `/transfers/${transfer.id}/dispatch`, { driver_name: 'Test Driver' });
  const t = await api(page, 'GET', `/transfers/${transfer.id}`);
  await api(page, 'PATCH', `/transfers/${transfer.id}/receive`, { delivered_by_name: 'Test Driver', items: [{ item_id: t.items[0].id, quantity_received: 2 }] });
  // The customer's line now holds the 3 from there plus the 2 that arrived — A's and B's.
  alloc = await api(page, 'GET', `/consignment/allocations?transaction_id=${s3.id}`);
  expect(alloc.reduce((n, a) => n + a.qty, 0)).toBe(5);
  expect(alloc.map(a => [a.agreement_number, a.qty])).toEqual([[A, 3], [A, 1], [B, 1]]);
  expect(alloc.at(-1).unit_cost).toBe(90);

  // A stock adjustment down with no owned stock left comes off a supplier's receipt, logged as such.
  await api(page, 'PATCH', `/products/${item.id}/stock`, { adjustment: -1, reason: 'Missing on shelf', branch_id: main.id });
  expect((await lots(page, item.id, main.id)).map(l => [l.agreement, l.on_hand])).toEqual([[B, 1]]);

  // Everything still adds up to the branch figures.
  const check = await api(page, 'GET', '/consignment/lot-check');
  expect(check.mismatches.filter(m => m.product_id === item.id)).toEqual([]);
});
