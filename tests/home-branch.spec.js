import { test, expect } from './fixtures.js';

// Sales and quotes are made at the signed-in person's default branch, even
// with multi-branch access. A quote keeps its own branch whoever edits it.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const refused = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d).then(() => 'allowed', e => e.message), [method, url, data]);

async function signIn(page, username, password) {
  await page.waitForLoadState('networkidle');
  await page.context().clearCookies();
  await page.goto('/');
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('button.login-btn');
  await page.waitForFunction(u => App.currentUser?.username === u && document.querySelector('#content').innerHTML.length > 0, username);
}

test('POS, layaway and quotes only use the default branch; a quote keeps its branch on edit', async ({ page }) => {
  const s = `${Date.now()}`;
  const stores = (await api(page, 'GET', '/branches')).filter(b => b.active && !b.is_warehouse);
  expect(stores.length).toBeGreaterThan(1);
  const [home, other] = stores;
  const product = await page.evaluate(() => App.api('GET', '/products').then(ps => ps.find(p => !p.is_rental && !p.is_service && p.price > 0)));
  const items = [{ product_id: product.id, quantity: 1, unit_price: product.price }];
  const cust = await api(page, 'POST', '/customers', { first_name: 'Home', last_name: `Branch ${s}`, phone: `876${s.slice(-7)}` });

  // Two salespeople with multi-branch access, based at different branches.
  const group = await api(page, 'POST', '/security-groups', { name: `Multi ${s}`, description: '', permissions: { pos: true, quotations: true, layaway: true, layaway_create: true, multi_branch_access: true } });
  const mk = (u, branch) => api(page, 'POST', '/employees', { first_name: 'Sales', last_name: u, username: u, pin: String(Math.floor(100000 + Math.random() * 899999)), password: 'pw-123456', must_change_password: 0, security_group_id: group.id, default_branch_id: branch.id, active: 1 });
  const here = `hbh${s}`, there = `hbt${s}`;
  await mk(here, home);
  await mk(there, other);

  // Based elsewhere: their quote is made at their branch.
  await signIn(page, there, 'pw-123456');
  const theirs = await api(page, 'POST', '/quotations', { branch_id: other.id, quote_type: 'retail', items });
  expect(theirs.branch_id).toBe(other.id);

  await signIn(page, here, 'pw-123456');
  // Multi-branch access, but the POS offers only the default branch.
  expect(await page.evaluate(() => App._posBranches().map(b => b.id))).toEqual([home.id]);

  // The server refuses another branch for a hold, a sale, a layaway or a quote.
  const line = [{ product_id: product.id, quantity: 1, price: product.price }];
  expect(await refused(page, 'POST', '/transactions/hold', { branch_id: other.id, items: line })).toContain('default branch');
  expect(await refused(page, 'POST', '/transactions', { branch_id: other.id, payment_method: 'cash', items: line })).toContain('default branch');
  expect(await refused(page, 'POST', '/layaway/plans', { customer_id: cust.id, branch_id: other.id, items: [{ product_id: product.id, quantity: 1 }] })).toContain('default branch');
  expect(await refused(page, 'POST', '/quotations', { branch_id: other.id, quote_type: 'retail', items })).toContain('default branch');
  const mine = await api(page, 'POST', '/quotations', { branch_id: home.id, quote_type: 'retail', items });
  expect(mine.branch_id).toBe(home.id);

  // The quote form is fixed on the default branch for a new quote…
  await page.evaluate(() => App.showQuoteForm());
  await expect(page.locator('#qt-branch')).toBeDisabled();
  await expect(page.locator('#qt-branch option:checked')).toHaveText(home.name);
  await page.evaluate(() => App.closeModal());

  // …and on the quote's own branch when editing one from elsewhere, which
  // an edit can't move.
  await page.evaluate(id => App.showQuoteForm(id), theirs.id);
  await expect(page.locator('#qt-branch option:checked')).toHaveText(other.name);
  await page.evaluate(() => App.closeModal());
  await api(page, 'PUT', `/quotations/${theirs.id}`, { branch_id: home.id, items });
  expect((await api(page, 'GET', `/quotations/${theirs.id}`)).branch_id).toBe(other.id);
});
