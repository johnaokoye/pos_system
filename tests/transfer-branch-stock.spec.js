import { test, expect } from './fixtures.js';

// A branch with no stock record for an item has none of it: a transfer from
// there is refused, never sent out of the item's company-wide stock (which
// used to create a record at that branch out of nothing).
const api = (page, m, u, d) => page.evaluate(([m, u, d]) => App.api(m, u, d), [m, u, d]);
const attempt = (page, m, u, d) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'accepted', e => e.message), [m, u, d]);
const branchStock = async (page, branchId, productId) => ((await api(page, 'GET', `/products?branch_id=${branchId}`)).find(p => p.id === productId) || {}).stock_qty;

async function setup(page) {
  const [main, other] = (await api(page, 'GET', '/branches')).filter(b => b.active !== 0);
  const s = `${Date.now()}`;
  const p = await api(page, 'POST', '/products', { name: `Branch stock test ${s}`, sku: `BST${s}`, price: 10, cost: 5, tax_rate: 0, stock_qty: 0, active: 1 });
  // Stock it at the main branch only — the other branch has no record for it.
  await api(page, 'PATCH', `/products/${p.id}/stock`, { adjustment: 20, reason: 'test', branch_id: main.id });
  return { main, other, p };
}

test('a transfer from a branch with no stock record for the item is refused, and no stock appears there', async ({ page }) => {
  const { main, other, p } = await setup(page);
  const before = await api(page, 'GET', `/products/${p.id}`);
  test.skip(!(before.stock_qty > 0), 'could not stock the test item at the main branch');
  expect(await branchStock(page, other.id, p.id)).toBe(0);

  const msg = await attempt(page, 'POST', '/transfers/quick', { from_branch_id: other.id, to_branch_id: main.id, items: [{ product_id: p.id, quantity: 3 }] });
  expect(msg).toContain('Insufficient available stock');
  expect(msg).toContain('available: 0');
  expect(await branchStock(page, other.id, p.id)).toBe(0);
  expect((await api(page, 'GET', `/products/${p.id}`)).stock_qty).toBe(before.stock_qty);

  // From the branch that has it, it still goes.
  expect(await attempt(page, 'POST', '/transfers/quick', { from_branch_id: main.id, to_branch_id: other.id, items: [{ product_id: p.id, quantity: 3 }] })).toBe('accepted');
  expect(await branchStock(page, other.id, p.id)).toBe(3);
  expect((await api(page, 'GET', `/products/${p.id}`)).stock_qty).toBe(before.stock_qty);
});

test('an accepted quote sourcing from a branch without the item puts that part on the purchase request instead', async ({ page }) => {
  const { main, other, p } = await setup(page);
  test.skip(!((await api(page, 'GET', `/products/${p.id}`)).stock_qty > 0), 'could not stock the test item at the main branch');
  const q = await api(page, 'POST', '/quotations', { employee_id: 1, branch_id: main.id, items: [{ product_id: p.id, quantity: 25, sources: [{ branch_id: main.id, quantity: 20 }, { branch_id: other.id, quantity: 5 }] }] });
  await api(page, 'PATCH', `/quotations/${q.id}/status`, { status: 'accepted' });
  const sources = (await api(page, 'GET', `/quotations/${q.id}`)).items[0].sources;
  expect(sources.find(s => s.branch_id === other.id)).toBeUndefined();
  expect(sources.find(s => s.branch_id === null)).toMatchObject({ quantity: 5 });
  expect(sources.find(s => s.branch_id === null).purchase_request_number).toBeTruthy();
  expect(await branchStock(page, other.id, p.id)).toBe(0);
});

test('a layaway at a branch with no stock record for the item is refused, and no stock appears there', async ({ page }) => {
  const { main, other, p } = await setup(page);
  const before = await api(page, 'GET', `/products/${p.id}`);
  test.skip(!(before.stock_qty > 0), 'could not stock the test item at the main branch');
  await api(page, 'PUT', `/products/${p.id}`, { ...before, is_layaway_eligible: 1 });
  const s = `${Date.now()}`;
  const customer = await api(page, 'POST', '/customers', { first_name: 'Lay', last_name: `Away${s}`, phone: `876${s.slice(-7)}` });
  const msg = await attempt(page, 'POST', '/layaway/plans', { customer_id: customer.id, branch_id: other.id, employee_id: 1, items: [{ product_id: p.id, quantity: 2 }], payment_method: 'cash', amount_tendered: 100 });
  expect(msg).toContain('Not enough stock');
  expect(msg).toContain('0 available');
  expect(await branchStock(page, other.id, p.id)).toBe(0);
  expect((await api(page, 'GET', `/products/${p.id}`)).stock_qty).toBe(before.stock_qty);
});
